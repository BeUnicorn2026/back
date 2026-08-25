package config

import "testing"

func TestLivemapModelDefaultsToOpenRouterModel(t *testing.T) {
	t.Setenv("AI_API_TOKEN", "secret")
	t.Setenv("OPENROUTER_MODEL", "shared-model")
	t.Setenv("LIVEMAP_MODEL", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LivemapModel != "shared-model" {
		t.Fatalf("LivemapModel = %q, want shared model", cfg.LivemapModel)
	}
}

func TestLoadRequiresAIAPIToken(t *testing.T) {
	t.Setenv("AI_API_TOKEN", "")
	if _, err := Load(); err == nil {
		t.Fatal("Load should reject an empty AI_API_TOKEN")
	}
}

func TestLivemapModelOverride(t *testing.T) {
	t.Setenv("AI_API_TOKEN", "secret")
	t.Setenv("OPENROUTER_MODEL", "shared-model")
	t.Setenv("LIVEMAP_MODEL", "live-model")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LivemapModel != "live-model" {
		t.Fatalf("LivemapModel = %q, want override", cfg.LivemapModel)
	}
}

func TestMaximumBodyBytesNeverExceedsOneMiB(t *testing.T) {
	t.Setenv("AI_API_TOKEN", "secret")
	for _, value := range []string{"1048577", "999999999", "0", "-1", "invalid"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("AI_MAXIMUM_BODY_BYTES", value)
			cfg, err := Load()
			if err != nil {
				t.Fatal(err)
			}
			if cfg.MaximumBodyBytes != MaximumAIRequestBytes {
				t.Fatalf("MaximumBodyBytes = %d, want absolute cap %d", cfg.MaximumBodyBytes, MaximumAIRequestBytes)
			}
		})
	}
}

func TestMaximumBodyBytesAllowsSmallerConfiguredLimit(t *testing.T) {
	t.Setenv("AI_API_TOKEN", "secret")
	t.Setenv("AI_MAXIMUM_BODY_BYTES", "4096")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaximumBodyBytes != 4096 {
		t.Fatalf("MaximumBodyBytes = %d, want 4096", cfg.MaximumBodyBytes)
	}
}
