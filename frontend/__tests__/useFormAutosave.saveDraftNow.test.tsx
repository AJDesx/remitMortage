// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { renderHook } from "@testing-library/react";
import { useFormAutosave } from "../src/hooks/useFormAutosave";

describe("useFormAutosave.saveDraftNow", () => {
  beforeEach(() => localStorage.clear());

  it("writes the latest form data immediately, without waiting for the debounce", () => {
    const { result } = renderHook(() =>
      useFormAutosave({ amount: "100" }, { key: "draft-now", debounceMs: 60_000 })
    );

    result.current.saveDraftNow();

    expect(JSON.parse(localStorage.getItem("draft-now")!)).toMatchObject({ amount: "100" });
  });

  it("does not create a draft for an empty form", () => {
    const { result } = renderHook(() =>
      useFormAutosave({ amount: "" }, { key: "draft-empty", debounceMs: 60_000 })
    );

    result.current.saveDraftNow();

    expect(localStorage.getItem("draft-empty")).toBeNull();
  });
});
