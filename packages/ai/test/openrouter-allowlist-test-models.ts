import { isValidApprovedOpenRouterSelector } from "@oh-my-pi/pi-ai/openrouter-allowlist";

/**
 * OpenRouter selectors referenced by mock/provider tests. Hermetic suites install
 * this list through the test preload under OMP_OPENROUTER_ALLOWLIST_TEST_MODE=1.
 * Production runtime never reads this module.
 */
const RAW_OPENROUTER_TEST_MODELS = [
	"openrouter/acme/big",
	"openrouter/anthropic/claude-3.5-sonnet",
	"openrouter/anthropic/claude-fable-5",
	"openrouter/anthropic/claude-haiku-latest",
	"openrouter/anthropic/claude-haiku-latest:online",
	"openrouter/anthropic/claude-opus-5",
	"openrouter/anthropic/claude-sonnet-4",
	"openrouter/anthropic/claude-sonnet-4.5",
	"openrouter/anthropic/claude-sonnet-4:online",
	"openrouter/custom/model",
	"openrouter/deepseek/deepseek-chat",
	"openrouter/deepseek/deepseek-r1",
	"openrouter/deepseek/deepseek-v4-flash",
	"openrouter/deepseek/deepseek-v4-flash-0731",
	"openrouter/google/gemini-2.5-flash",
	"openrouter/google/gemini-3.5-flash",
	"openrouter/inclusionai/ling-3.0-flash",
	"openrouter/kimi-k2.6",
	"openrouter/mock/header-model",
	"openrouter/moonshotai/kimi-k2",
	"openrouter/moonshotai/kimi-k2.5",
	"openrouter/moonshotai/kimi-k2.6",
	"openrouter/moonshotai/kimi-k2.7-code",
	"openrouter/moonshotai/Kimi-K2-Instruct",
	"openrouter/nvidia/nemotron-3.5-lightning",
	"openrouter/openai/gpt-4o:extended",
	"openrouter/openai/gpt-5.4",
	"openrouter/openai/gpt-5.5",
	"openrouter/openai/gpt-5.5-pro",
	"openrouter/openai/gpt-oss-20b",
	"openrouter/openai/text-embedding-3-small",
	"openrouter/openrouter-reasoner",
	"openrouter/pi-native-cache",
	"openrouter/pi-native-usage",
	"openrouter/poolside/laguna-s-2.1",
	"openrouter/qwen/qwen3-coder:exacto",
	"openrouter/stepfun/step-3.7-flash",
	"openrouter/tencent/hy3",
	"openrouter/test/router-model",
	"openrouter/test/router-model-thinking",
	"openrouter/z-ai/glm-4.7",
	"openrouter/z-ai/glm-4.7@cerebras",
	"openrouter/z-ai/glm-4.7@fireworks",
	"openrouter/z-ai/glm-5.2",
	"openrouter/z-ai/glm-5.3-flash",
] as const;

export const OPENROUTER_ALLOWLIST_TEST_MODELS: readonly string[] = RAW_OPENROUTER_TEST_MODELS.filter(selector => {
	if (!isValidApprovedOpenRouterSelector(selector)) {
		throw new Error(`Invalid OpenRouter test allowlist selector: ${selector}`);
	}
	return true;
});
