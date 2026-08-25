package livemap

// ReattachCandidates returns orphan nodes of the current topic that have not yet
// exhausted their reattachment budget (ReattachTries < 2). These are the nodes a
// later turn should retry Call B for once new parents may exist.
func ReattachCandidates(state *State) []*Node {
	candidates := make([]*Node, 0)
	if state == nil || len(state.Topics) == 0 {
		return candidates
	}
	topic := state.Topics[len(state.Topics)-1]
	for _, id := range topic.NodeIDs {
		node := state.Nodes[id]
		if node == nil {
			continue
		}
		if node.Orphan && node.ReattachTries < maxReattachTrie {
			candidates = append(candidates, node)
		}
	}
	return candidates
}

// MarkTopicBoundary finalizes the orphans of every topic except the current one:
// once a topic is closed its orphans can no longer be reattached, so their
// reattach budget is exhausted. It returns the finalized orphan nodes.
func MarkTopicBoundary(state *State) []*Node {
	finalized := make([]*Node, 0)
	if state == nil {
		return finalized
	}
	for index := 0; index < len(state.Topics)-1; index++ {
		for _, id := range state.Topics[index].NodeIDs {
			node := state.Nodes[id]
			if node == nil || !node.Orphan {
				continue
			}
			if node.ReattachTries < maxReattachTrie {
				node.ReattachTries = maxReattachTrie
				finalized = append(finalized, node)
			}
		}
	}
	return finalized
}
