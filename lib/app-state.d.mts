export interface AppElement {
  index: string;
  parentIndex?: string;
  id?: string;
  role: string;
  name: string;
  description?: string;
  value?: string;
  url?: string;
  disabled: boolean;
  settable: boolean;
  secondaryActions: string[];
  line: string;
  context: string;
  rowContext?: string;
  cellValueContext: string;
  descendants: string;
}
export interface AppObservation {
  app: string;
  title: string | null;
  url: string | null;
  documentIdentity: { windowUrl: string | null; pageUrls: string[] } | null;
  nativeWindowIdentity: boolean;
  nativeSheetId?: string;
  text: string;
  focused?: AppElement;
  /** Sky reported this focused index, but it is absent from the parsed tree. */
  focusedOutsideTree?: string;
  focusedWindow?: boolean;
  elements: AppElement[];
  observedAt: number;
}
export function parseAppState(app: string, text: string): AppObservation;
export function parseMaskedContexts(
  text: string,
  maskedSlots: ReadonlyMap<number, number>,
): { context: string; rowContext?: string }[];
export function sameElementIdentity(expected: AppElement, candidate: AppElement): boolean;
export function selectContextualCandidate<
  C extends { context?: string | undefined; rowContext?: string | undefined },
>(
  expected: { context?: string | undefined; rowContext?: string | undefined },
  candidates: readonly C[],
): C | undefined;
export function sameDocument(before: AppObservation, after: AppObservation): boolean;
export function findUniqueElement(
  element: AppElement,
  observation: AppObservation,
): AppElement | undefined;
export function findContextElement(
  element: AppElement,
  observation: AppObservation,
): AppElement | undefined;
export function findSameElement(
  element: AppElement,
  observation: AppObservation,
): AppElement | undefined;
export function sameElementMismatch(
  element: AppElement,
  observation: AppObservation,
): { cause: "absent" | "inside" | "around" } | { cause: "alike"; count: number };
