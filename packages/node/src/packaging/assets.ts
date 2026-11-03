import type { Project } from '@elabora/core/project/model';
import { findItem, playerConfig } from '@elabora/core/player/config';
import { iterateBlocks, screenOrder, resolveBlockProps, planIndex } from '@elabora/core/project/load';
import { interfaceSounds, soundAssets, soundUses } from '@elabora/core/sounds/sounds';
import { getRegistry } from '@elabora/core/components/registry';
import type { Registry } from '@elabora/core/components/registry';
import { valuesOfKind } from '@elabora/core/components/props';
import { MEDIA_EXTENSIONS, extensionOf } from '@elabora/core/media/conformance';

// The files of assets/ a package ships, by name under assets/, each once: those its blocks' props
// and its screens' layouts name (props of kind asset: unused files are not shipped), the player's
// logo and the course's resources (D58), the sounds its screens play outside a narration track, and
// those an interface role plays instead of the player's own when interface sounds are on (D67).
export function shippedAssets(project: Project, registry: Registry = getRegistry(project)): string[] {
  const { course, plan } = project;
  if (!course || !plan) return [];
  const planLookup = planIndex(plan);
  const names: string[] = [];
  const ship = (asset: unknown) => {
    if (typeof asset === 'string') names.push(asset);
  };
  for (const { block } of iterateBlocks(project)) {
    const descriptor = registry.get(block.type);
    if (!descriptor) continue;
    for (const found of valuesOfKind(descriptor.schema, resolveBlockProps(block, planLookup, registry), 'asset')) ship(found.value);
  }
  for (const { id } of screenOrder(project)) {
    const screen = project.screens.get(id)?.data;
    const layout = screen?.layout ? registry.get(screen.layout) : null;
    if (layout && screen?.layoutProps) for (const found of valuesOfKind(layout.schema, screen.layoutProps, 'asset')) ship(found.value);
  }
  const logo = findItem(playerConfig(course), 'logo')?.item;
  if (logo?.id === 'logo' && logo.enabled && logo.options.asset) ship(logo.options.asset);
  for (const resource of course.resources ?? []) ship(resource.asset);
  const active = interfaceSounds(project).active;
  const soundFiles = soundAssets(project);
  for (const use of soundUses(project)) if (!use.inTrack && (use.kind !== 'interface' || active)) ship(soundFiles.get(use.id)?.asset);
  return [...new Set(names)];
}

// Media are files on disk (masters, or renditions below the high quality); other assets are read.
// A media job's output not written yet is media too.
export function isMediaAsset(project: Project, name: string): boolean {
  const file = project.files.get(`assets/${name}`);
  if (!file) return !!project.media?.processing.includes(`assets/${name}`);
  return file.kind === 'binary' && (!!file.media || MEDIA_EXTENSIONS.has(extensionOf(name)));
}
