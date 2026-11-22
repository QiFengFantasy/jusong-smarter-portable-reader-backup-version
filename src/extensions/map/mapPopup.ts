import type { MapPlace } from "./types";

export function createTextElement(tag: string, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function createPlaceTooltip(place: MapPlace): HTMLElement {
  return createTextElement("span", place.name);
}

export function createPlacePopup(place: MapPlace): HTMLElement {
  const popup = createTextElement("div", "", "map-popup");
  popup.appendChild(createTextElement("strong", place.name));
  if (place.modernName && place.modernName !== place.name) {
    popup.appendChild(createTextElement("span", place.modernName, "map-popup__modern"));
  }
  if (place.description) {
    popup.appendChild(createTextElement("span", place.description, "map-popup__hint"));
  }
  return popup;
}
