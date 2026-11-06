import type { Project } from '@elabora/core/project/model';
import { findItem, playerConfig } from '@elabora/core/player/config';
import { iterateBlocks, screenOrder, resolveBlockProps, planIndex } from '@elabora/core/project/load';
import { interfaceSounds, soundAssets, soundUses } from '@elabora/core/sounds/sounds';
import { getRegistry } from '@elabora/core/components/registry';
import type { Registry } from '@elabora/core/components/registry';
import { objectAssets, valuesOfKind } from '@elabora/core/components/props';
import { MEDIA_EXTENSIONS, extensionOf } from '@elabora/core/media/conformance';
import type { MediaUse } from '@elabora/core/media/weights';

// The files of assets/ a package ships, by name under assets/, each once: those its blocks' props
// and its screens' layouts name (props of kind asset: unused files are not shipped), the player's
// logo and the course's resources (D58), the sounds its screens play outside a narration track, and
// those an interface role plays instead of the player's own when interface sounds are on (D67).
export function shippedAssets(project: Project, registry: Registry = getRegistry(project)): string[] {
  return [...assetUses(project, registry).keys()];
}

// The same, with where the course uses each, in the course's order.
export function assetUses(project: Project, registry: Registry = getRegistry(project)): Map<string, MediaUse[]> {
  const { course, plan } = project;
  const uses = new Map<string, MediaUse[]>();
  if (!course || !plan) return uses;
  const planLookup = planIndex(plan);
  const ship = (asset: unknown, use: MediaUse) => {
    if (typeof asset !== 'string') return;
    const known = uses.get(asset);
    if (!known) uses.set(asset, [use]);
    else if (!known.some((other) => other.screen === use.screen && other.block === use.block && other.layer === use.layer && other.as === use.as)) known.push(use);
  };
  for (const { screen, layer, block } of iterateBlocks(project)) {
    const descriptor = registry.get(block.type);
    if (!descriptor) continue;
    const props = resolveBlockProps(block, planLookup, registry);
    const use = { screen: screen.id, ...(typeof block.id === 'string' ? { block: block.id } : {}), ...(typeof layer?.id === 'string' ? { layer: layer.id } : {}) };
    for (const found of valuesOfKind(descriptor.schema, props, 'asset')) ship(found.value, use);
    // A free object's settings name files of the course too (x-control "asset").
    if (descriptor.lineage.includes('free-object')) for (const found of objectAssets(project.objects.get(String(props.object))?.manifest, props.props)) ship(found.value, use);
  }
  const backdrop = course.theme?.backdrop?.object;
  if (backdrop) for (const found of objectAssets(project.objects.get(backdrop.id)?.manifest, backdrop.props)) ship(found.value, { screen: null });
  for (const { id } of screenOrder(project)) {
    const screen = project.screens.get(id)?.data;
    const layout = screen?.layout ? registry.get(screen.layout) : null;
    if (layout && screen?.layoutProps) for (const found of valuesOfKind(layout.schema, screen.layoutProps, 'asset')) ship(found.value, { screen: id });
  }
  const logo = findItem(playerConfig(course), 'logo')?.item;
  if (logo?.id === 'logo' && logo.enabled && logo.options.asset) ship(logo.options.asset, { screen: null, as: 'logo' });
  for (const resource of course.resources ?? []) ship(resource.asset, { screen: null, as: 'resource' });
  const active = interfaceSounds(project).active;
  const soundFiles = soundAssets(project);
  const screenOf = new Map([...project.screens].map(([id, entry]) => [entry.file ?? `screens/${id}.json`, id]));
  for (const use of soundUses(project)) {
    if (use.inTrack || (use.kind === 'interface' && !active)) continue;
    const where: MediaUse = use.kind === 'interface' ? { screen: null, as: 'interface-sound' } : use.kind === 'background' ? { screen: null, as: 'background' } : { screen: screenOf.get(use.file) ?? null };
    ship(soundFiles.get(use.id)?.asset, where);
  }
  return uses;
}

// Media are files on disk (masters, or renditions below the high quality); other assets are read.
// A media job's output not written yet is media too.
export function isMediaAsset(project: Project, name: string): boolean {
  const file = project.files.get(`assets/${name}`);
  if (!file) return !!project.media?.processing.includes(`assets/${name}`);
  return file.kind === 'binary' && (!!file.media || MEDIA_EXTENSIONS.has(extensionOf(name)));
}
