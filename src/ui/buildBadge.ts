interface BuildInfo {
  id: string;
  builtAt: string;
}

/** Visible on every build so testers can include an exact identifier in reports. */
export async function mountBuildBadge(): Promise<void> {
  const badge = document.createElement('div');
  badge.id = 'build-id';
  // Without the shared class it had no positioning at all and laid out as a
  // full-width static block behind the top of the HUD (D-032).
  badge.className = 'panel';
  badge.textContent = 'build …';
  document.body.appendChild(badge);
  try {
    const response = await fetch('/data/build.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const info = await response.json() as BuildInfo;
    badge.textContent = info.id;
    badge.title = `Generated ${info.builtAt}`;
  } catch {
    badge.textContent = 'build local-unidentified';
  }
}
