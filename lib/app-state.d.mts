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
  nativeWindowIdentity: boolean;
  nativeSheetId?: string;
  text: string;
  focused?: AppElement;
  elements: AppElement[];
  observedAt: number;
}
export function parseAppState(app: string, text: string): AppObservation;
export function sameDocument(before: AppObservation, after: AppObservation): boolean;
export function findUniqueElement(element: AppElement, observation: AppObservation): AppElement | undefined;
export function findContextElement(element: AppElement, observation: AppObservation): AppElement | undefined;
export function findSameElement(element: AppElement, observation: AppObservation): AppElement | undefined;
