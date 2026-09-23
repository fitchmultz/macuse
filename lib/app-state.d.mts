export interface AppElement {
  index: string;
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
  descendants: string;
}
export interface AppObservation {
  app: string;
  title: string | null;
  url: string | null;
  text: string;
  focused?: AppElement;
  elements: AppElement[];
  observedAt: number;
}
export function parseAppState(app: string, text: string): AppObservation;
export function sameDocument(before: AppObservation, after: AppObservation): boolean;
export function findSameElement(element: AppElement, observation: AppObservation): AppElement | undefined;
