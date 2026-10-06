export interface Point {
  x: number
  y: number
}

export type PaperSize = 'a4' | 'letter' | 'a3' | 'tabloid'

export interface CaptureCrop {
  x: number
  y: number
  width: number
  height: number
}

/** Source-position heuristic metadata; not calibrated camera intrinsics. */
export interface CaptureFrame {
  source_width: number
  source_height: number
  corrected_to_source: [[number, number, number], [number, number, number], [number, number, number]]
  optical_center: Point
  full_frame_width: number
  full_frame_height: number
}

export interface FingerHole {
  id: string
  x: number
  y: number
  radius: number
  rotation?: number
  shape?: CutoutShape
  width?: number
  height?: number
  depth_override?: number | null
}

export type CutoutShape = 'circle' | 'cylinder' | 'square' | 'rectangle' | 'filleted_rectangle'

export type AccessPocketShape = 'rectangle' | 'scoop'
export type AccessPocketEdge = 'inherit' | 'sharp' | 'chamfer' | 'fillet'

/**
 * A bin-local finger-access pocket cut into the bin's usable interior.
 * `length`/`width` are the nominal opening dimensions before the opening-edge
 * finish widens the rim; `depth` is the vertical cut below the surface. A
 * `scoop` is a genuine rounded 3D trough (curved bottom, rounded ends) whose
 * width and depth are independent, so `corner_radius`/`bottom_radius` do not
 * apply to it.
 */
export interface AccessPocket {
  id: string
  shape: AccessPocketShape
  x: number
  y: number
  length: number
  width: number
  depth: number
  rotation: number
  edge: AccessPocketEdge
  edge_size: number
  corner_radius: number
  bottom_radius: number
}

export interface Polygon {
  id: string
  points: Point[]
  label: string
  finger_holes: FingerHole[]
  interior_rings: Point[][]
}

export interface TextLabel {
  id: string
  text: string
  x: number
  y: number
  font_size: number
  rotation: number
  emboss: boolean
  depth: number
}

export interface Layout {
  bin_config: BinConfig
  polygons: Polygon[]
  text_labels: TextLabel[]
}

export interface PhotoWarning {
  code: string
  message: string
}

export interface Session {
  id: string
  name: string | null
  description: string | null
  tags: string[]
  created_at: string | null
  original_image_path: string | null
  corrected_image_path: string | null
  mask_image_path: string | null
  corners: Point[] | null
  paper_size: PaperSize | null
  scale_factor: number | null
  focal_length_35mm: number | null
  photo_warnings: PhotoWarning[] | null
  capture_frame?: CaptureFrame | null
  polygons: Polygon[] | null
  stl_path: string | null
  layout: Layout | null
}

export interface SessionSummary {
  id: string
  name: string | null
  description: string | null
  tags: string[]
  created_at: string | null
  thumbnail_url: string | null
  tool_count: number
  has_stl: boolean
}

export interface UploadResponse {
  session_id: string
  image_url: string
  detected_corners: Point[] | null
  image_width: number | null
  image_height: number | null
  corner_source: 'detected' | 'station' | 'none'
  station_id: string | null
}

export interface CornersResponse {
  corrected_image_url: string
  scale_factor: number
  warnings: PhotoWarning[]
  capture_frame?: CaptureFrame | null
}

export interface PhotoStation {
  id: string
  name: string
  image_width: number
  image_height: number
  image_path: string | null
  capture_crop: CaptureCrop | null
  paper_size: PaperSize
  corners: Point[]
  created_at: string | null
  updated_at: string | null
  last_used_at: string | null
}

export interface TraceResponse {
  polygons: Polygon[]
  mask_url: string | null
}

export interface GenerateResponse {
  stl_url: string
  stl_urls?: string[]
  threemf_url?: string
  split_count?: number
  zip_url?: string | null
  insert_stl_url?: string | null
  warning?: string | null
}

export interface BinDefaults {
  grid_x: number
  grid_y: number
  height_units: number
  magnets: boolean
  magnet_diameter: number
  magnet_depth: number
  magnet_corners_only: boolean
  stacking_lip: boolean
  /** Add a standard 1×1 stacking lip to every cutout-free full cell so smaller
   *  bins can stack inside a larger bin, away from its outer edges. Requires
   *  stacking_lip; kept dormant rather than cleared while the outer lip is off. */
  stacking_lip_empty_cells: boolean
  rim_units: number
  wall_thickness: number
  cutout_depth: number
  /** 'automatic' derives each measured tool's shallowest stacking-safe depth;
   *  'uniform' applies cutout_depth to every tool; null is a pre-feature bin
   *  that keeps honouring its stored per-placement overrides. */
  cutout_depth_mode: 'automatic' | 'uniform' | null
  /** Clearance kept between a tool's top and the underside of the bin above. */
  stacking_clearance_mm: number
  cutout_clearance: number
  cutout_chamfer: number
  insert_enabled: boolean
  insert_height: number
  insert_clearance: number
  half_grid_base: boolean
  partial_bins: boolean
  partial_bins_values: boolean[]
  partial_bins_connect: boolean
  partial_bins_retain_wall: boolean
  bed_size: number
}

export interface BinConfig extends BinDefaults {
  text_labels: TextLabel[]
  access_pockets: AccessPocket[]
}

// --- tool library ---

export interface Tool {
  id: string
  name: string
  thickness_mm?: number | null
  points: Point[]
  finger_holes: FingerHole[]
  interior_rings: Point[][]
  smoothed: boolean
  smooth_level: number
  source_session_id: string | null
  image_context: ToolImageContext | null
  category: string | null
  drawer: string | null
  tags: string[]
  project_ids: string[]
  review_status: string | null
  needs_cleanup: boolean
  created_at: string | null
}

export type AffineMatrix = [number, number, number, number, number, number]

export interface ToolImageContext {
  image_url: string
  image_width: number
  image_height: number
  origin_x_mm: number
  origin_y_mm: number
  scale_factor: number
  transform: AffineMatrix
}

export interface ToolSummary {
  id: string
  name: string
  thickness_mm?: number | null
  created_at: string | null
  point_count: number
  points: Point[]
  interior_rings: Point[][]
  smoothed: boolean
  smooth_level: number
  thumbnail_url: string | null
  image_transform: AffineMatrix | null
  image_context: ToolImageContext | null
  category: string | null
  drawer: string | null
  tags: string[]
  project_ids: string[]
  review_status: string | null
  needs_cleanup: boolean
}

// --- projects ---

export type ProjectStatus = 'active' | 'ready_to_print' | 'printed' | 'archived'
export type ProjectHealthSeverity = 'warning' | 'error'
export type ProjectHealthCode =
  | 'missing_tool'
  | 'missing_bin'
  | 'bin_missing_project_id'
  | 'bin_project_mismatch'
  | 'outside_tool'
  | 'tool_missing_project_id'
  | 'tool_extra_project_id'

/** Position of one bin on the project drawer grid, in gridfinity units from the top-left. */
export interface ProjectBinPlacement {
  id: string
  bin_id: string
  x: number
  y: number
  rotation: number
  /** #rrggbb highlight colour, or null for the default bin colour. */
  color: string | null
  support_id?: string | null
}

/** One drawer plan inside a project: a grid plus the bins placed on it. */
export interface ContainerLimits {
  container_width_mm?: number | null
  container_depth_mm?: number | null
  container_height_mm?: number | null
  safety_clearance_mm?: number
}

/**
 * Measured usable-floor boundary in drawer-space millimetres (x right, y down).
 * `points` is the outer ring; `interior_rings` are excluded obstructions.
 */
export interface DrawerOutline {
  points: Point[]
  interior_rings: Point[][]
}

/** Plan-owned uncorrected original, corrected metric frame and paper context. */
export interface DrawerPhotoCalibration {
  session_id: string
  corrected_image_url: string
  original_image_url: string | null
  image_width: number
  image_height: number
  paper_size: PaperSize
  /** millimetres per corrected-image pixel */
  scale_factor: number
  corners: Point[]
  seed: Point | null
}

/** The grid frame relative to the drawer origin: an anchor and a turn. */
export interface DrawerGridAlignment {
  origin_x_mm: number
  origin_y_mm: number
  rotation_deg: number
}

export interface ProjectSketch extends ContainerLimits {
  id: string
  name: string
  target_grid_x: number | null
  target_grid_y: number | null
  bin_layout: ProjectBinPlacement[]
  outline?: DrawerOutline | null
  source?: DrawerPhotoCalibration | null
  grid_alignment?: DrawerGridAlignment
  fit_clearance_mm?: number
  created_at: string | null
  updated_at: string | null
}

/** A candidate interior boundary returned by the provider, in millimetres. */
export interface DrawerOutlineCandidate {
  outline: DrawerOutline
  mask_url: string | null
  image_width: number
  image_height: number
}

export interface BinProject {
  id: string
  name: string
  description: string | null
  status: ProjectStatus
  tool_ids: string[]
  bin_ids: string[]
  placed_tool_ids: string[]
  unplaced_tool_ids: string[]
  sketches: ProjectSketch[]
  default_bin_config: BinDefaults | null
  notes: string | null
  created_at: string | null
  updated_at: string | null
}

export interface BinProjectSummary {
  id: string
  name: string
  description: string | null
  status: ProjectStatus
  tool_count: number
  bin_count: number
  placed_count: number
  unplaced_count: number
  sketch_count: number
  created_at: string | null
  updated_at: string | null
}

export interface ProjectHealthIssue {
  code: ProjectHealthCode
  severity: ProjectHealthSeverity
  message: string
  tool_id: string | null
  bin_id: string | null
  other_project_id: string | null
  repairable: boolean
}

export interface ProjectHealthResponse {
  issues: ProjectHealthIssue[]
  repairable_count: number
  manual_count: number
}

// --- bins ---

export interface PlacedTool {
  // Unique placement instance; repeated copies share tool_id, never id.
  id: string
  tool_id: string
  name: string
  points: Point[]
  finger_holes: FingerHole[]
  interior_rings: Point[][]
  rotation: number
  pinned?: boolean
  depth_override?: number | null
  /** 'custom' keeps depth_override; 'automatic' derives the depth; null is a
   *  pre-feature placement that keeps a stored override, else the bin mode. */
  depth_mode?: 'automatic' | 'custom' | null
}

/**
 * Planning-only metadata for a bin whose geometry was uploaded rather than
 * generated. Dimensions are the uploaded mesh's bounding box in millimetres;
 * `bin_config` on the bin carries the detected nominal grid and height, which
 * is a planning approximation and never proof of physical fit.
 */
export interface ImportedModelMetadata {
  width_mm: number
  depth_mm: number
  height_mm: number
  warnings: string[]
}

export interface BinData {
  id: string
  name: string | null
  project_id: string | null
  bin_config: BinConfig
  placed_tools: PlacedTool[]
  text_labels: TextLabel[]
  stl_path: string | null
  created_at: string | null
  imported_model?: ImportedModelMetadata | null
}

export interface BinPreviewTool {
  points: Point[]
  interior_rings: Point[][]
}

export interface BinSummary {
  id: string
  name: string | null
  project_id: string | null
  created_at: string | null
  tool_ids: string[]
  tool_count: number
  has_stl: boolean
  grid_x: number
  grid_y: number
  height_units: number
  half_grid_base: boolean
  preview_tools: BinPreviewTool[]
  imported_model?: ImportedModelMetadata | null
}

export interface ToolEnvelope {
  id: string
  tool_id: string
  name: string
  points: Point[]
  interior_rings: Point[][]
  thickness_mm: number | null
  effective_depth_mm: number | null
  resting_z_mm: number | null
  seating_verified: boolean
  insert_height_mm: number
  top_mm: number | null
  clearance_mm: number | null
}

export interface FitViolation {
  code: string
  message: string
  tool_id?: string
  placement_id?: string
  other_placement_id?: string
  clearance_mm?: number
}

export interface BinHeightAssessment {
  status: 'verified' | 'uncertain' | 'invalid'
  external_height_mm: number
  stack_increment_mm: number
  clearance_mm: number | null
  limiting_tool_id: string | null
  missing_tool_ids: string[]
  envelopes: ToolEnvelope[]
  violations: FitViolation[]
}

export interface HeightProposal {
  strategy: 'deeper_pockets' | 'raised_rim'
  complete: boolean
  bin_config?: BinConfig | null
  placed_tools?: PlacedTool[]
  override_changes?: { id: string; from_mm: number; to_mm: number }[]
  external_height_mm?: number
  clearance_mm?: number
  reason: string | null
}

export interface BinHeightPlanning {
  assessment: BinHeightAssessment
  alternatives: HeightProposal[]
}

export interface PlanPlacementAssessment {
  placement_id: string
  root_id: string
  z_mm: number
  top_mm: number
  headroom_mm: number | null
  external_height_mm: number
  support_compatible: boolean | null
  clearance_mm: number | null
  limiting_tool_id: string | null
  envelopes: ToolEnvelope[]
}

export interface ToolboxAssessment {
  status: 'verified' | 'uncertain' | 'invalid'
  geometry_revision: string
  bins: BinSummary[]
  violations: FitViolation[]
  unresolved: string[]
  missing_tool_ids: string[]
  unhoused_tool_ids: string[]
  placements: PlanPlacementAssessment[]
  grid_x: number | null
  grid_y: number | null
  width_mm: number | null
  depth_mm: number | null
  height_mm: number | null
  safety_clearance_mm: number
  residual_width_mm: number | null
  residual_depth_mm: number | null
  occupied_floor_units: number
  free_cells: { x: number; y: number; w: number; h: number }[]
  free_regions: { area_units: number; cells: Point[] }[]
  stacks: { root_id: string; headroom_mm: number | null }[]
  /** Area of the grid cells fully covered by the boundary, in grid units. */
  usable_area_units: number
  /** Continuous boundary area in grid units, or null for a rectangular plan. */
  floor_area_units: number | null
  grid_origin_mm: { x: number; y: number }
  fit_clearance_mm: number
}

export interface AuthStatus {
  mode: 'native' | 'proxy' | 'open'
  setup_required: boolean
  authenticated: boolean
}

export interface Account {
  id: string
  email: string
  is_admin: boolean
  disabled: boolean
  created_at: string
  totp_enabled: boolean
}

export interface LoginResult {
  pending: boolean
  pending_token: string | null
  account: Account | null
}

export interface TwoFactorEnrolment {
  secret: string
  otpauth_uri: string
}

export interface BackupCodes {
  backup_codes: string[]
}

export interface CreateUserRequest {
  email: string
  password: string
  is_admin?: boolean
}
