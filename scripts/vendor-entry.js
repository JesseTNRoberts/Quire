// Everything Quire needs from CodeMirror 6, bundled into public/vendor/codemirror.js (npm run vendor).
export { EditorState, EditorSelection, StateEffect, StateField, RangeSetBuilder, Prec } from '@codemirror/state';
export { EditorView, ViewPlugin, Decoration, WidgetType, keymap, placeholder, drawSelection } from '@codemirror/view';
export { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
