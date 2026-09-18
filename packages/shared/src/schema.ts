/**
 * Zod schema for one extracted page. Mirrors the Output section of
 * prompts/page-extraction-prompt.md (and scripts/schema.py, which is the
 * Python twin used by the extraction runner). If the prompt's output block
 * changes, change both.
 */
import { z } from "zod";

export const PAGE_TYPES = [
  "walkthrough", "map", "item_table", "boss", "npc", "lore", "index", "other",
] as const;

export const FIGURE_KINDS = ["map", "screenshot", "diagram", "icon_row"] as const;

export const ENTITY_TYPES = [
  "item", "weapon", "armor", "talisman", "spell", "ash_of_war", "consumable", "key_item",
  "location", "region", "dungeon", "boss", "enemy", "npc", "merchant", "site_of_grace",
] as const;

export const IMAGE_QUALITY = ["good", "usable", "poor", "unusable"] as const;

export const QUALITY_ISSUES = [
  "blur", "glare", "shadow", "skew", "crop_cut_off", "low_resolution", "page_curl", "motion_blur",
  "color_cast", "fingers_or_obstruction", "two_pages_in_frame", "other",
] as const;

export const OCR_AGREEMENT = ["high", "medium", "low"] as const;

/** Entity types that denote a place; used by retrieval for route questions. */
export const LOCATION_ENTITY_TYPES = ["location", "region", "dungeon", "site_of_grace"] as const;

const nullableString = z.string().nullable();

export const FigureSchema = z.strictObject({
  kind: z.enum(FIGURE_KINDS),
  description: z.string(),
  labels: z.array(z.string()),
  legend: nullableString,
});

export const EntitySchema = z.strictObject({
  type: z.enum(ENTITY_TYPES),
  name: z.string().min(1),
  location: nullableString,
  how_to_obtain: nullableString,
  connects_to: z.array(z.string()),
});

export const QualitySchema = z.strictObject({
  image_quality: z.enum(IMAGE_QUALITY),
  quality_issues: z.array(z.enum(QUALITY_ISSUES)),
  affected_areas: nullableString,
  retake_recommended: z.boolean(),
  retake_reason: nullableString,
  ocr_agreement: z.enum(OCR_AGREEMENT),
  illegible_regions: z.int().min(0),
  notes: nullableString,
});

export const PageSchema = z.strictObject({
  book: z.string().min(1),
  page: z.int().min(0),
  chapter: nullableString,
  region: nullableString,
  page_type: z.enum(PAGE_TYPES),
  markdown: z.string(),
  figures: z.array(FigureSchema),
  entities: z.array(EntitySchema),
  quality: QualitySchema,
});

export type Figure = z.infer<typeof FigureSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type Quality = z.infer<typeof QualitySchema>;
export type ExtractedPage = z.infer<typeof PageSchema>;
export type PageType = (typeof PAGE_TYPES)[number];
export type EntityType = (typeof ENTITY_TYPES)[number];
