import { act, fireEvent, render, screen } from "@testing-library/react";
import type { LexicalEditor } from "lexical";
import { describe, expect, it, vi } from "vitest";
import { writeComposerContent } from "@/features/conversation/composer/draft/composer-editor-content";
import { ComposerEditor } from "./ComposerEditor";

describe("ComposerEditor", () => {
  it("keeps Enter as a line break and reserves Ctrl+Enter for compact-editor submit", async () => {
    const editorRef: { current: LexicalEditor | null } = { current: null };
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ComposerEditor
        onChange={onChange}
        onSubmit={onSubmit}
        onMentionTrigger={() => {}}
        onMentionDismiss={() => {}}
        isMentionPopupOpen={false}
        onSlashTrigger={() => {}}
        onSlashDismiss={() => {}}
        isSlashPopupOpen={false}
        editorRef={editorRef}
        ariaLabel="Comment note"
        submitOnEnter={false}
      />,
    );

    await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
    await act(async () => {
      writeComposerContent(editorRef.current!, "First line\nSecond line");
    });
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("First line\nSecond line", []));

    const editor = screen.getByRole("textbox", { name: "Comment note" });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("submits with Ctrl+Enter instead of selecting an open popup", async () => {
    const editorRef: { current: LexicalEditor | null } = { current: null };
    const onPopupKeyDown = vi.fn(() => true);
    const onSubmit = vi.fn();
    render(
      <ComposerEditor
        onChange={() => {}}
        onSubmit={onSubmit}
        onMentionTrigger={() => {}}
        onMentionDismiss={() => {}}
        isMentionPopupOpen={false}
        onSlashTrigger={() => {}}
        onSlashDismiss={() => {}}
        isSlashPopupOpen={false}
        editorRef={editorRef}
        ariaLabel="Comment note"
        submitOnEnter={false}
        isPopupOpen
        onPopupKeyDown={onPopupKeyDown}
      />,
    );

    await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment note" }), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(onPopupKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  describe("focus across a disabled spell", () => {
    function renderComposer(disabled: boolean) {
      const editorRef: { current: LexicalEditor | null } = { current: null };
      let instance = "first";
      const element = (isDisabled: boolean) => (
        <>
          <ComposerEditor
            key={instance}
            onChange={() => {}}
            onSubmit={() => {}}
            onMentionTrigger={() => {}}
            onMentionDismiss={() => {}}
            isMentionPopupOpen={false}
            onSlashTrigger={() => {}}
            onSlashDismiss={() => {}}
            isSlashPopupOpen={false}
            editorRef={editorRef}
            ariaLabel="Composer"
            disabled={isDisabled}
          />
          <input aria-label="Search" />
        </>
      );
      const view = render(element(disabled));
      return {
        editorRef,
        setDisabled: (next: boolean) => view.rerender(element(next)),
        /** Swaps in a new composer under the same label, as a new thread's first message does. */
        replace: (nextDisabled: boolean) => {
          instance = "second";
          view.rerender(element(nextDisabled));
        },
      };
    }

    // A browser blurs an element that stops being editable; jsdom does not, so the tests blur it.
    function blurDisabledEditor() {
      (document.activeElement as HTMLElement | null)?.blur();
    }

    it("returns focus to the editor when it is enabled again, as after a new thread starts", async () => {
      const { editorRef, setDisabled } = renderComposer(false);
      await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
      const editor = screen.getByRole("textbox", { name: "Composer" });
      act(() => editor.focus());

      setDisabled(true);
      blurDisabledEditor();
      expect(document.activeElement).toBe(document.body);
      setDisabled(false);

      await vi.waitFor(() => expect(document.activeElement).toBe(editor));
    });

    it("gives focus to the composer that replaces a focused one once it is enabled", async () => {
      const { editorRef, setDisabled, replace } = renderComposer(false);
      await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
      act(() => screen.getByRole("textbox", { name: "Composer" }).focus());

      replace(true);
      expect(document.activeElement).toBe(document.body);
      setDisabled(false);

      await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Composer" })));
    });

    it("stays unfocused when the user pressed elsewhere while the editor was disabled", async () => {
      const { editorRef, setDisabled } = renderComposer(false);
      await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
      act(() => screen.getByRole("textbox", { name: "Composer" }).focus());

      setDisabled(true);
      blurDisabledEditor();
      fireEvent.pointerDown(document.body);
      setDisabled(false);

      await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
      expect(document.activeElement).toBe(document.body);
    });

    it("leaves focus where the user moved it while the editor was disabled", async () => {
      const { editorRef, setDisabled } = renderComposer(false);
      await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
      act(() => screen.getByRole("textbox", { name: "Composer" }).focus());

      setDisabled(true);
      blurDisabledEditor();
      const search = screen.getByRole("textbox", { name: "Search" });
      act(() => search.focus());
      setDisabled(false);

      await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
      expect(document.activeElement).toBe(search);
    });

    it("does not take focus on enable when the editor did not have it", async () => {
      const { editorRef, setDisabled } = renderComposer(true);
      await vi.waitFor(() => expect(editorRef.current).not.toBeNull());

      setDisabled(false);

      await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
      expect(document.activeElement).toBe(document.body);
    });
  });

  it("does not submit Enter while an IME composition is active", async () => {
    const onSubmit = vi.fn();
    render(
      <ComposerEditor
        onChange={() => {}}
        onSubmit={onSubmit}
        onMentionTrigger={() => {}}
        onMentionDismiss={() => {}}
        isMentionPopupOpen={false}
        onSlashTrigger={() => {}}
        onSlashDismiss={() => {}}
        isSlashPopupOpen={false}
        ariaLabel="Composer"
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Composer" }), {
      key: "Enter",
      isComposing: true,
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
