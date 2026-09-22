import { describe, expect, it } from "vitest";
import { squareCrop } from "./avatar-image";

describe("squareCrop", () => {
  it("takes the middle of a landscape image", () => {
    expect(squareCrop(4000, 3000)).toEqual({ sx: 500, sy: 0, size: 3000 });
  });

  it("takes the middle of a portrait image", () => {
    expect(squareCrop(3000, 4000)).toEqual({ sx: 0, sy: 500, size: 3000 });
  });

  it("leaves a square alone", () => {
    expect(squareCrop(512, 512)).toEqual({ sx: 0, sy: 0, size: 512 });
  });

  it("never asks for a zero-sized crop", () => {
    expect(squareCrop(0, 10).size).toBe(1);
  });
});
