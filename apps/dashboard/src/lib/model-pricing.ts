import { getBrowserBackendBaseUrl } from "./config";

export interface ModelPricing {
  model_name: string;
  match_pattern: string;
  provider: string;
  input_price: number;
  output_price: number;
  cached_input_price: number | null;
}

export interface CallCostBreakdown {
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  inputPricePer1M: number | null;
  outputPricePer1M: number | null;
  promptCost: number | null;
  completionCost: number | null;
  totalCost: number | null;
  providedCost: number | null;
  calculatedCost: number | null;
  hasPricing: boolean;
}

export interface ModelCostEntry {
  model: string;
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

let cache: ModelPricing[] | null = null;
let fetchPromise: Promise<ModelPricing[]> | null = null;

export function _resetPricingCache() {
  cache = null;
  fetchPromise = null;
}

export async function fetchModelPricing(): Promise<ModelPricing[]> {
  if (cache) return cache;
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch(`${getBrowserBackendBaseUrl()}/api/v1/models`)
    .then((res) => (res.ok ? res.json() : []))
    .then((data: ModelPricing[]) => {
      cache = data;
      fetchPromise = null;
      return data;
    })
    .catch(() => {
      fetchPromise = null;
      return [] as ModelPricing[];
    });

  return fetchPromise;
}

export function matchModelPricing(
  modelName: string,
  pricingList: ModelPricing[],
): ModelPricing | null {
  if (!modelName || modelName === "unknown") return null;
  for (const pricing of pricingList) {
    try {
      if (new RegExp(`^${pricing.match_pattern}$`, "i").test(modelName))
        return pricing;
    } catch {
      if (
        pricing.model_name === modelName ||
        pricing.match_pattern === modelName
      )
        return pricing;
    }
  }
  return null;
}

export function computeCallBreakdown(
  call: {
    model: string;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    cost?: number | null;
    provided_cost?: number | null;
    calculated_cost?: number | null;
  },
  pricingList: ModelPricing[],
): CallCostBreakdown {
  const pricing = matchModelPricing(call.model, pricingList);
  const promptTokens = call.prompt_tokens ?? null;
  const completionTokens = call.completion_tokens ?? null;

  let promptCost: number | null = null;
  let completionCost: number | null = null;

  if (pricing && promptTokens != null) {
    promptCost = (promptTokens / 1_000_000) * pricing.input_price;
  }
  if (pricing && completionTokens != null) {
    completionCost = (completionTokens / 1_000_000) * pricing.output_price;
  }

  const calculatedTotal =
    promptCost != null && completionCost != null
      ? promptCost + completionCost
      : null;

  return {
    model: call.model,
    promptTokens,
    completionTokens,
    inputPricePer1M: pricing?.input_price ?? null,
    outputPricePer1M: pricing?.output_price ?? null,
    promptCost,
    completionCost,
    totalCost: call.cost ?? calculatedTotal,
    providedCost: call.provided_cost ?? null,
    calculatedCost: call.calculated_cost ?? calculatedTotal,
    hasPricing: pricing != null,
  };
}

export function computeRunBreakdown(
  calls: Array<{
    model: string;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    cost?: number | null;
  }>,
): ModelCostEntry[] {
  const byModel = new Map<string, ModelCostEntry>();
  for (const call of calls) {
    const model = call.model || "unknown";
    const entry = byModel.get(model) ?? {
      model,
      callCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    };
    entry.callCount += 1;
    entry.promptTokens += call.prompt_tokens ?? 0;
    entry.completionTokens += call.completion_tokens ?? 0;
    entry.cost += call.cost ?? 0;
    byModel.set(model, entry);
  }
  return Array.from(byModel.values());
}
