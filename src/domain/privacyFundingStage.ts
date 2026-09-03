import { e2eHooksEnabled } from "./e2eHooks";

export type PrivacyFundingStageSnapshot = {
  stage: string;
  at: number;
};

let latestStage: PrivacyFundingStageSnapshot | null = null;

export function setPrivacyFundingStage(stage: string) {
  latestStage = { stage, at: Date.now() };
  if (e2eHooksEnabled()) {
    (
      window as unknown as {
        __zylithFundingStage?: PrivacyFundingStageSnapshot | null;
      }
    ).__zylithFundingStage = latestStage;
  }
}

export function getPrivacyFundingStage(sinceUnixMs = 0) {
  if (!latestStage) return null;
  if (sinceUnixMs > 0 && latestStage.at < sinceUnixMs) return null;
  return latestStage;
}
