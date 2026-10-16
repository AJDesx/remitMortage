// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useUnsavedChangesGuard } from "../src/hooks/useUnsavedChangesGuard";
import UnsavedChangesDialog from "../src/components/forms/UnsavedChangesDialog";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

interface HarnessProps {
  initialValue?: string;
  onSaveDraft?: () => void | Promise<void>;
}

/** A form with a next/link-style anchor: its own click handler "navigates" via router.push. */
function Harness({ initialValue = "", onSaveDraft }: HarnessProps) {
  const [value, setValue] = useState(initialValue);
  const { dialogProps, allowNavigation } = useUnsavedChangesGuard({
    isDirty: value !== "",
    onSaveDraft,
  });

  async function submit() {
    await allowNavigation();
    setValue("");
    mockPush("/dashboard");
  }

  return (
    <div>
      <a
        href="/dashboard"
        onClick={(event) => {
          event.preventDefault();
          mockPush("/dashboard");
        }}
      >
        Dashboard
      </a>
      <a href="https://example.com/elsewhere">External</a>
      <a href="/docs" target="_blank" rel="noreferrer" onClick={(e) => e.preventDefault()}>
        New tab
      </a>
      <label htmlFor="field">Field</label>
      <input id="field" value={value} onChange={(e) => setValue(e.target.value)} />
      <button onClick={() => void submit()}>Submit</button>
      <button onClick={() => setValue("")}>Clear</button>
      <UnsavedChangesDialog {...dialogProps} />
    </div>
  );
}

function fireBeforeUnload(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  mockPush.mockClear();
  window.history.replaceState(null, "", "/");
});

describe("useUnsavedChangesGuard — clean state", () => {
  it("never warns on tab close and lets links navigate when nothing is dirty", async () => {
    render(<Harness />);
    expect(fireBeforeUnload()).toBe(false);

    await userEvent.click(screen.getByText("Dashboard"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
  });
});

describe("useUnsavedChangesGuard — dirty state", () => {
  it("asks the browser to confirm tab close / reload", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    expect(fireBeforeUnload()).toBe(true);
  });

  it("stops warning once the form is clean again", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Clear"));
    expect(fireBeforeUnload()).toBe(false);
  });

  it("intercepts an in-app link and shows the dialog instead of navigating", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));

    expect(screen.getByRole("alertdialog", { name: "Leave without saving?" })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not intercept new-tab, modified-click or external links", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");

    await userEvent.click(screen.getByText("New tab"));
    fireEvent.click(screen.getByText("Dashboard"), { ctrlKey: true });
    const external = screen.getByText("External");
    external.addEventListener("click", (e) => e.preventDefault());
    await userEvent.click(external);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("confirm and cancel paths", () => {
  it("Stay closes the dialog, keeps the edits and does not navigate", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    const link = screen.getByText("Dashboard");
    await userEvent.click(link);

    await userEvent.click(screen.getByRole("button", { name: "Stay on page" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Field")).toHaveValue("abc");
    expect(link).toHaveFocus();
  });

  it("Discard navigates to the clicked destination", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("offers Save draft only when drafts are supported", async () => {
    const { unmount } = render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));
    expect(screen.queryByRole("button", { name: /save draft/i })).not.toBeInTheDocument();
    unmount();

    render(<Harness onSaveDraft={jest.fn()} />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));
    expect(screen.getByRole("button", { name: /save draft/i })).toBeInTheDocument();
  });

  it("Save draft saves first, then leaves", async () => {
    const onSaveDraft = jest.fn().mockResolvedValue(undefined);
    render(<Harness onSaveDraft={onSaveDraft} />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));

    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/dashboard"));
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it("stays open with an error when the draft cannot be saved", async () => {
    const onSaveDraft = jest.fn().mockRejectedValue(new Error("quota"));
    render(<Harness onSaveDraft={onSaveDraft} />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));

    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved/i);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("keyboard accessibility", () => {
  it("moves focus to the safe Stay action and labels the dialog", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Leave without saving?");
    expect(dialog).toHaveAccessibleDescription(/unsaved changes/i);
    expect(screen.getByRole("button", { name: "Stay on page" })).toHaveFocus();
  });

  it("Escape stays on the page", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("keeps Tab / Shift+Tab inside the dialog", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));

    const discard = screen.getByRole("button", { name: "Discard changes" });
    const stay = screen.getByRole("button", { name: "Stay on page" });

    await userEvent.tab();
    expect(discard).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(stay).toHaveFocus();
  });

  it("can be completed with the keyboard alone (Tab to Discard, Enter)", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Dashboard"));

    await userEvent.tab(); // wraps from Stay to Discard
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/dashboard"));
  });
});

describe("post-submit case", () => {
  it("clears the warning immediately after a successful submit", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    expect(fireBeforeUnload()).toBe(true);

    await userEvent.click(screen.getByText("Submit"));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fireBeforeUnload()).toBe(false);
  });

  it("does not prompt for a link clicked right after submit", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Submit"));
    mockPush.mockClear();

    await userEvent.click(screen.getByText("Dashboard"));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
  });

  it("does not leave a stray guard history entry behind after submit", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    await userEvent.click(screen.getByText("Submit"));
    await flush();

    expect(window.history.state?.__unsavedChangesGuard).toBeUndefined();
  });
});

describe("browser back button", () => {
  it("pushes a guard entry while dirty and drops it when clean", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");
    expect(window.history.state?.__unsavedChangesGuard).toBe(true);

    await userEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(window.history.state?.__unsavedChangesGuard).toBeUndefined());
  });

  it("opens the dialog on back, and Stay restores the guard entry", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");

    act(() => window.history.back());
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Stay on page" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(window.history.state?.__unsavedChangesGuard).toBe(true);
  });

  it("Discard after back continues going back", async () => {
    const back = jest.spyOn(window.history, "back");
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Field"), "abc");

    act(() => window.history.back());
    await screen.findByRole("alertdialog");
    back.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    back.mockRestore();
  });
});
