import { describe, expect, it } from "vitest";
import {
  buildStoryboard,
  demoOwnerAssets,
  demoOwnerProfile,
  emptyOwnerProfile,
  generateMissingShots,
  generateScriptVariant,
  getProfileCompletion,
  getStoryboardCoverage,
  inferAssetKind,
  isAssemblyReady,
  recommendTemplate,
} from "./owner-creator-workflow";

describe("owner creator workflow", () => {
  it("requires the minimum profile instead of optional sensitive fields", () => {
    expect(getProfileCompletion(emptyOwnerProfile)).toMatchObject({ completed: 0, total: 9, ready: false });
    expect(getProfileCompletion({ ...demoOwnerProfile, industry: "", ageBand: "", city: "" })).toMatchObject({ completed: 9, total: 9, ready: true });
  });

  it("creates parallel script versions from confirmed profile facts", () => {
    const first = generateScriptVariant({ profile: demoOwnerProfile, templateId: "pain-solution", brief: "为什么我们不卖隔夜包子", version: 1, followupAnswers: ["顾客最担心早高峰要排队。"] });
    const second = generateScriptVariant({ profile: demoOwnerProfile, templateId: "pain-solution", brief: "为什么我们不卖隔夜包子", version: 2 });
    expect(first.beats.map((beat) => beat.text).join(" ")).toContain("王姐");
    expect(first.beats.map((beat) => beat.text).join(" ")).toContain("凌晨四点半");
    expect(first.beats.map((beat) => beat.text).join(" ")).toContain("早高峰要排队");
    expect(second.id).not.toBe(first.id);
    expect(second.beats[0].text).not.toBe(first.beats[0].text);
    expect(first.beats.every((beat) => beat.sourceLabels.length > 0)).toBe(true);
  });

  it("uses only rights-confirmed material and leaves explicit gaps", () => {
    const variant = generateScriptVariant({ profile: demoOwnerProfile, templateId: "behind-scenes", brief: "拍一条早餐店幕后", version: 1 });
    const shots = buildStoryboard(variant, [...demoOwnerAssets, { ...demoOwnerAssets[0], id: "unlicensed", rightsConfirmed: false }]);
    expect(shots.filter((shot) => shot.status === "matched")).toHaveLength(4);
    expect(shots.find((shot) => shot.materialKind === "graphic")?.status).toBe("missing");
    expect(shots.some((shot) => shot.assetId === "unlicensed")).toBe(false);
    expect(isAssemblyReady(shots)).toBe(false);
  });

  it("generates only allowed gaps and opens the assembly gate when coverage is complete", () => {
    const variant = generateScriptVariant({ profile: demoOwnerProfile, templateId: "behind-scenes", brief: "拍一条早餐店幕后", version: 1 });
    const generated = generateMissingShots(buildStoryboard(variant, demoOwnerAssets));
    expect(getStoryboardCoverage(generated)).toMatchObject({ ready: 5, missing: 0, blocked: 0, complete: true });
    expect(isAssemblyReady(generated)).toBe(true);
  });

  it("keeps real-customer evidence blocked when no authorized material exists", () => {
    const variant = generateScriptVariant({ profile: demoOwnerProfile, templateId: "case", brief: "讲一个真实顾客案例", version: 1 });
    const generated = generateMissingShots(buildStoryboard(variant, demoOwnerAssets));
    expect(generated.find((shot) => shot.materialKind === "customer")?.status).toBe("blocked");
    expect(isAssemblyReady(generated)).toBe(false);
  });

  it("infers useful upload categories and custom-template recommendations", () => {
    expect(inferAssetKind("凌晨备料制作.mp4")).toBe("process");
    expect(inferAssetKind("老板正面介绍.mov")).toBe("person");
    expect(recommendTemplate("为什么我们不卖隔夜包子")).toBe("knowledge");
    expect(recommendTemplate("拍一天的制作过程")).toBe("behind-scenes");
  });
});
