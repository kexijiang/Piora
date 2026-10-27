"use client";

import { defaultKeymap } from "@codemirror/commands";
import { search, searchKeymap, openSearchPanel, setSearchQuery, SearchQuery, findNext } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";

interface Props {
  output: string;
  wrap: boolean;
  streaming?: boolean;
  searchText?: string;
  searchRequest?: number;
  endRequest?: number;
  ariaLabel: string;
  onFollowChange?: (following: boolean) => void;
  onOverflowChange?: (overflows: boolean) => void;
}

export function CommandLogViewer({ output, wrap, streaming = false, searchText = "", searchRequest = 0, endRequest = 0, ariaLabel, onFollowChange, onOverflowChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const followingRef = useRef(streaming);
  const outputRef = useRef(output);
  outputRef.current = output;
  const onFollowChangeRef = useRef(onFollowChange);
  const initialOptionsRef = useRef({ wrap, streaming });
  onFollowChangeRef.current = onFollowChange;
  const onOverflowChangeRef = useRef(onOverflowChange);
  onOverflowChangeRef.current = onOverflowChange;
  const [wrapCompartment] = useState(() => new Compartment());

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: outputRef.current,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-multiline": "true", spellcheck: "false" }),
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          search({ top: true }),
          keymap.of([...searchKeymap, ...defaultKeymap]),
          wrapCompartment.of(initialOptionsRef.current.wrap ? EditorView.lineWrapping : []),
          EditorView.domEventHandlers({
            scroll(_event, current) {
              const scroll = current.scrollDOM;
              const next = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 8;
              if (followingRef.current !== next) {
                followingRef.current = next;
                onFollowChangeRef.current?.(next);
              }
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    // Observe both viewport and content: wrapping, streamed lines and container
    // resizing can all turn a short log into a scrollable one.
    const observer = new ResizeObserver(() => {
      onOverflowChangeRef.current?.(view.scrollDOM.scrollHeight > view.scrollDOM.clientHeight + 1);
    });
    observer.observe(view.scrollDOM);
    observer.observe(view.contentDOM);
    if (initialOptionsRef.current.streaming) view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    return () => { observer.disconnect(); viewRef.current = null; view.destroy(); };
  }, [ariaLabel, wrapCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const document = view.state.toText(output);
    if (document.eq(view.state.doc)) return;
    const follow = streaming && followingRef.current;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: document },
      ...(follow ? { selection: { anchor: document.length }, scrollIntoView: true } : {}),
    });
  }, [output, streaming]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap, wrapCompartment]);

  useEffect(() => {
    if (!searchRequest) return;
    const view = viewRef.current;
    if (!view) return;
    if (searchText) {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: searchText, caseSensitive: false })) });
      findNext(view);
    }
    openSearchPanel(view);
    view.focus();
  }, [searchRequest, searchText]);

  useEffect(() => {
    if (!endRequest) return;
    const view = viewRef.current;
    if (!view) return;
    followingRef.current = true;
    onFollowChangeRef.current?.(true);
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    // The last cursor position may leave the content's bottom padding below
    // the viewport. An explicit jump should reach the actual end of the log.
    view.requestMeasure({
      read: () => view.scrollDOM.scrollHeight,
      write: (height) => { view.scrollDOM.scrollTop = height; },
    });
    view.focus();
  }, [endRequest]);

  return <div ref={hostRef} className="command-log-editor" />;
}
