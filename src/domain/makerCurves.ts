export type CurvePoint = { price: string; baseAmount: string };
export type CurveDir = "bid" | "ask";

export function defaultCurveBands(): CurvePoint[] {
  return [
    { price: "", baseAmount: "" },
    { price: "", baseAmount: "" },
    { price: "", baseAmount: "" },
  ];
}
