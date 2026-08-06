import { QUALITY, storeTier, type QualityTier } from '../render/quality';

export interface QualityControl {
  element: HTMLElement;
}

/**
 * Runtime quality changes require renderer/terrain reconstruction, so the
 * control stores the choice and reloads the current URL. This keeps the policy
 * explicit and deterministic instead of partially mutating a live renderer.
 */
export function mountQualityControl(activeTier: QualityTier): QualityControl {
  const root = document.createElement('label');
  root.id = 'quality-control';
  root.innerHTML = '<span>Quality</span>';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Rendering quality');
  for (const tier of ['low', 'medium', 'high'] as const) {
    const option = document.createElement('option');
    option.value = tier;
    option.textContent = QUALITY[tier].label;
    option.selected = tier === activeTier;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    const tier = select.value as QualityTier;
    storeTier(tier);
    window.location.reload();
  });
  root.appendChild(select);
  // Mounted inside the controls sheet (D-032). It was a floating dark chip over
  // the battlefield, in a different visual language from everything near it, for
  // a choice a player makes once a session.
  (document.getElementById('controls-settings') ?? document.body).appendChild(root);
  return { element: root };
}
