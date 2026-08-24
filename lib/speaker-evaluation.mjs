import { chooseKnownSpeaker } from "./speaker-matching.mjs";

const ratio = (value, total) => total ? value / total : null;

function quantile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.round((sorted.length - 1) * percentile));
  return sorted[index];
}

export function evaluateSpeakerTrials(trials, speakers, options = {}) {
  const threshold = Number(options.threshold ?? 0.72);
  const margin = Number(options.margin ?? 0.04);
  const respectSpeakerThresholds = options.respectSpeakerThresholds !== false;
  const evaluatedSpeakers = respectSpeakerThresholds
    ? speakers
    : speakers.map((speaker) => ({ ...speaker, matchThreshold: threshold }));
  const confusion = {};
  const genuineScores = [];
  const impostorScores = [];
  let knownTrials = 0;
  let unknownTrials = 0;
  let correct = 0;
  let falseRejected = 0;
  let misidentified = 0;
  let falseAccepted = 0;

  const decisions = trials.map((trial) => {
    const expectedIndex = speakers.findIndex(({ id }) => id === trial.expectedSpeakerId);
    const expected = expectedIndex >= 0 ? speakers[expectedIndex] : null;
    const predicted = chooseKnownSpeaker(trial.scores, evaluatedSpeakers, { threshold, margin });
    const expectedLabel = expected?.name || "미등록 화자";
    const predictedLabel = predicted?.name || "거절";
    confusion[expectedLabel] ||= {};
    confusion[expectedLabel][predictedLabel] = (confusion[expectedLabel][predictedLabel] || 0) + 1;

    if (expected) {
      knownTrials += 1;
      genuineScores.push(Number(trial.scores[expectedIndex]));
      trial.scores.forEach((score, index) => { if (index !== expectedIndex) impostorScores.push(Number(score)); });
      if (!predicted) falseRejected += 1;
      else if (predicted.id === expected.id) correct += 1;
      else misidentified += 1;
    } else {
      unknownTrials += 1;
      impostorScores.push(Math.max(...trial.scores.map(Number)));
      if (predicted) falseAccepted += 1;
    }

    return {
      file: trial.file,
      expected: expectedLabel,
      predicted: predictedLabel,
      confidence: predicted?.score ?? null,
      scores: Object.fromEntries(speakers.map((speaker, index) => [speaker.name, Number(trial.scores[index])]))
    };
  });

  const unknownRejected = unknownTrials - falseAccepted;
  return {
    configuration: { threshold, margin, respectSpeakerThresholds },
    counts: { trials: trials.length, knownTrials, unknownTrials, correct, falseRejected, misidentified, falseAccepted },
    rates: {
      identificationAccuracy: ratio(correct, knownTrials),
      falseRejectionRate: ratio(falseRejected, knownTrials),
      misidentificationRate: ratio(misidentified, knownTrials),
      falseAcceptanceRate: ratio(falseAccepted, unknownTrials),
      overallDecisionAccuracy: ratio(correct + unknownRejected, trials.length)
    },
    scoreDistribution: {
      genuine: { p10: quantile(genuineScores, 0.1), median: quantile(genuineScores, 0.5), p90: quantile(genuineScores, 0.9) },
      impostor: { p10: quantile(impostorScores, 0.1), median: quantile(impostorScores, 0.5), p90: quantile(impostorScores, 0.9) }
    },
    confusion,
    decisions
  };
}

export function calibrateSpeakerThreshold(trials, speakers, options = {}) {
  const margin = Number(options.margin ?? 0.04);
  const minimum = Number(options.minimum ?? 0.55);
  const maximum = Number(options.maximum ?? 0.9);
  const step = Number(options.step ?? 0.01);
  const hasKnown = trials.some((trial) => speakers.some(({ id }) => id === trial.expectedSpeakerId));
  const hasUnknown = trials.some((trial) => trial.expectedSpeakerId == null);
  if (!hasKnown || !hasUnknown || speakers.length < 1) {
    return { ready: false, reason: "등록 화자 검증음과 미등록 화자 검증음이 모두 필요합니다." };
  }

  let best = null;
  for (let threshold = minimum; threshold <= maximum + Number.EPSILON; threshold += step) {
    const rounded = Math.round(threshold * 1_000) / 1_000;
    const report = evaluateSpeakerTrials(trials, speakers, {
      threshold: rounded, margin, respectSpeakerThresholds: false
    });
    const score = (report.rates.falseAcceptanceRate || 0) * 3
      + (report.rates.misidentificationRate || 0) * 2
      + (report.rates.falseRejectionRate || 0);
    if (!best || score < best.objective || (score === best.objective && rounded > best.threshold)) {
      best = { threshold: rounded, margin, objective: score, rates: report.rates };
    }
  }
  return { ready: true, ...best };
}

export function assessBenchmarkCoverage(trials, speakers, minimumPerClass = 5) {
  const counts = Object.fromEntries(speakers.map(({ id, name }) => [id, { name, probes: 0 }]));
  let unknownProbes = 0;
  for (const trial of trials) {
    if (trial.expectedSpeakerId == null) unknownProbes += 1;
    else if (counts[trial.expectedSpeakerId]) counts[trial.expectedSpeakerId].probes += 1;
  }
  const warnings = [];
  for (const { name, probes } of Object.values(counts)) {
    if (probes < minimumPerClass) warnings.push(`${name}의 별도 검증 음성이 ${minimumPerClass}개 미만입니다. 현재 ${probes}개입니다.`);
  }
  if (unknownProbes < minimumPerClass) warnings.push(`미등록 화자 검증 음성이 ${minimumPerClass}개 미만입니다. 현재 ${unknownProbes}개입니다.`);
  return {
    ready: warnings.length === 0,
    minimumPerClass,
    known: counts,
    unknownProbes,
    warnings
  };
}
