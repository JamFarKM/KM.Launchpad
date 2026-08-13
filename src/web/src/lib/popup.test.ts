import { describe, expect, it } from "vitest";
import { placePopupWidth } from "./popup";

const VW = 1440;
/** The Review page's PROJ picker: sized to the word "Account". */
const SHORT = { left: 40, right: 145, width: 105 };

describe("placePopupWidth", () => {
  it("treats the anchor width as a floor, not the width", () => {
    const p = placePopupWidth(SHORT, VW);
    expect(p.minWidth).toBe(105);
    expect(p.maxWidth).toBeGreaterThan(105);
  });

  it("lets a popup on a short control grow wide enough to read", () => {
    // The bug: a 105px popup rendered every option as four characters plus an ellipsis.
    expect(placePopupWidth(SHORT, VW).maxWidth).toBe(420);
  });

  it("opens rightward from the anchor's left edge in the normal case", () => {
    const p = placePopupWidth(SHORT, VW);
    expect(p.left).toBe(40);
    expect(p.right).toBeUndefined();
  });

  it("never lets the popup exceed the room to the right edge", () => {
    const nearEdge = { left: 1200, right: 1300, width: 100 };
    const p = placePopupWidth(nearEdge, VW);
    // Either it fits within the remaining room, or it flipped to open leftward.
    if (p.left !== undefined) expect(p.left + p.maxWidth).toBeLessThanOrEqual(VW);
  });

  it("flips to open leftward when there is no useful room rightward", () => {
    const p = placePopupWidth({ left: 1380, right: 1430, width: 50 }, VW);
    expect(p.right).toBeDefined();
    expect(p.left).toBeUndefined();
    expect(p.maxWidth).toBeGreaterThan(50);
  });

  it("keeps a flipped popup inside the viewport", () => {
    const p = placePopupWidth({ left: 1380, right: 1430, width: 50 }, VW);
    expect(p.right!).toBeGreaterThanOrEqual(8);
    expect(p.maxWidth).toBeLessThanOrEqual(1430 - 8);
  });

  it("does not flip a control that is already wide", () => {
    // A wide field near the right edge still has room for its own width; flipping would move a
    // popup that was already correctly placed.
    const p = placePopupWidth({ left: 900, right: 1400, width: 500 }, VW);
    expect(p.left).toBe(900);
  });

  it("degrades rather than going negative in a very narrow viewport", () => {
    const p = placePopupWidth({ left: 4, right: 60, width: 56 }, 100);
    expect(p.maxWidth).toBeGreaterThan(0);
  });
});
