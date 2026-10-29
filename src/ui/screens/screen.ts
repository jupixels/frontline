/** A full-screen (or modal) UI view managed by UiApp. */
export interface Screen {
  readonly el: HTMLElement;
  /** Return true if the key was handled (stops further handling). */
  onKey?(e: KeyboardEvent): boolean;
  dispose?(): void;
}
