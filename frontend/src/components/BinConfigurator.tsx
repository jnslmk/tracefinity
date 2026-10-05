'use client'

import { useEffect, useId, useState } from 'react'
import { hashKey, useQuery } from '@tanstack/react-query'
import { planBinHeight } from '@/lib/api'
import { Check, CircleHelp, Info, X } from 'lucide-react'
import type { BinConfig, HeightProposal, PlacedTool } from '@/types'
import { NumericInput } from '@/components/NumericInput'
import { createPartialBinsValues } from '@/lib/binDefaults'
import { MAX_GRID_UNITS, maxGridUnitsForOtherAxis } from '@/lib/constants'
import type { GridSizingMode } from '@/lib/constants'
import { BED_SIZE_MAX_MM, BED_SIZE_MIN_MM } from '@/lib/settings'
import { cn } from '@/lib/utils'
import { ClassValue } from 'clsx'
import { useTheme } from '@/hooks/useTheme'

const GF_HEIGHT_UNIT = 7.0
const GF_BASE_HEIGHT = 4.75
// Match generate_bin: the lip and raised rim sit above the pocket surface.
export function calcMaxCutoutDepth(heightUnits: number): number {
  return heightUnits * GF_HEIGHT_UNIT - GF_BASE_HEIGHT - 2
}

interface Props {
  config: BinConfig
  onChange: (config: BinConfig) => void
  gridSizingMode?: GridSizingMode
  onGridSizingModeChange?: (mode: GridSizingMode) => void
}

function HelpTip({ text }: { text: string }) {
  return (
    <span className="group ml-1">
      <Info className="w-3 h-3 text-text-muted cursor-help inline-block" />
      <span className="absolute left-0 right-0 bottom-full mb-1.5 px-2 py-1.5 text-[11px] leading-tight text-text-primary bg-elevated border border-border-subtle rounded whitespace-normal opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-30 shadow-lg">
        {text}
      </span>
    </span>
  )
}

function Toggle({ checked, onChange, label, help, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string; disabled?: boolean }) {
  return (
    <div className={`relative flex items-center justify-between py-2 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <span className="text-xs text-text-primary tracking-[0.3px]">
        {label}
        {help && <HelpTip text={help} />}
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded transition-colors ${
          checked ? 'bg-accent' : 'bg-elevated'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-sm transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
          }`}
          style={{
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: checked ? '#3096bc' : '#334155',
            backgroundColor: checked ? '#fff' : 'rgba(235,236,236,0.3)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
          }}
        />
      </button>
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  sliderMax = max,
  step = 1,
  unit,
  help,
  onChange,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  sliderMax?: number
  step?: number
  unit?: string
  help?: string
  onChange: (v: number) => void
  disabled?: boolean
}) {
  const pct = sliderMax > min ? ((value - min) / (sliderMax - min)) * 100 : 0
  const id = useId()

  return (
    <div className={`relative space-y-1.5 py-2 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <label htmlFor={id} className="text-xs text-text-primary tracking-[0.3px]">
        {label}
        {help && <HelpTip text={help} />}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={min}
          max={sliderMax}
          aria-label={label}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = step >= 1 ? parseInt(e.target.value) : parseFloat(e.target.value)
            onChange(Math.min(v, max))
          }}
          className="flex-1 min-w-0"
          style={{ '--slider-pct': `${pct}%` } as React.CSSProperties}
        />
        <label aria-label={`${label} value`} className="flex items-center gap-1">
          <NumericInput
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={onChange}
            className="w-14 h-7 bg-elevated text-right text-xs font-semibold text-text-primary rounded pr-2 focus:outline-none"
          />
          {unit && <span className="text-[10px] text-text-muted w-5">{unit}</span>}
        </label>
      </div>
    </div>
  )
}

function RadioMatrix({ sizeX, sizeY, values, onChange }: { sizeX: number; sizeY: number; values: boolean[]; onChange: (v: boolean[]) => void }) {
  let containerClasses: ClassValue = "gap-1 p-1 mx-1 rounded-md w-1/3";
  if (sizeX > 1) containerClasses = "gap-1 p-1 mx-1 rounded-sm w-1/2";
  if (sizeX > 2) containerClasses = "gap-1 p-1 mx-1 rounded-sm";
  if (sizeX > 4) containerClasses = "gap-px p-0 mx-0 rounded-sm";

  return (
      <div className={cn("grid bg-base p-2 mx-2 rounded-md", containerClasses)} style={{ gridTemplateColumns: `repeat(${sizeX}, 1fr)`, gridTemplateRows: `repeat(${sizeY}, 1fr)` }}>
          {values.map((value, index) => (
              <button
                  key={index}
                  onClick={() => {
                      if (value && values.filter(Boolean).length <= 1) return;
                      onChange(values.map((v, i) => (i === index ? !v : v)));
                  }}
                  className={cn("w-full border-2 aspect-square border-muted min-w-3", value ? "bg-accent border-accent" : "bg-elevated border-muted", sizeX > 4 ? "rounded-[2px]" : "rounded-sm")}
              ></button>
          ))}
      </div>
  );
}

function HintBanner({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme()
  return (
    <div className={cn("text-[11px] mt-1 leading-tight", theme === 'dark' ? 'text-amber-400' : 'text-amber-600')}>
      {children}
    </div>
  )
}

export function BinConfigurator({ config, onChange, gridSizingMode, onGridSizingModeChange }: Props) {
  function update(partial: Partial<BinConfig>) {
    onChange({ ...config, ...partial })
  }

  const maxCutoutDepth = calcMaxCutoutDepth(config.height_units)
  const binWidth = config.grid_x * 42
  const binDepth = config.grid_y * 42
  const needsSplit = config.bed_size > 0 && (binWidth > config.bed_size || binDepth > config.bed_size)
  const sizingId = useId()
  const depthModeId = useId()
  const exportsSeparateParts = config.partial_bins && !config.partial_bins_connect && config.partial_bins_values.some((enabled) => !enabled);

  return (
    <div className="space-y-0">
      {onGridSizingModeChange && (
        <div className="space-y-1.5 py-2">
          <label htmlFor={sizingId} className="text-xs text-text-primary">Grid sizing</label>
          <select
            id={sizingId}
            value={gridSizingMode}
            onChange={e => onGridSizingModeChange(e.target.value as GridSizingMode)}
            className="w-full rounded bg-elevated px-2 py-1.5 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
          >
            <option value="auto">Auto width and depth</option>
            <option value="fixed">Fixed width and depth</option>
            <option value="fixed_depth">Fixed depth, auto width</option>
          </select>
        </div>
      )}

      <SliderRow
        label="Grid Width"
        help="Bin width in gridfinity units (42mm each). Half-unit increments (21mm) supported."
        value={config.grid_x}
        min={1}
        max={maxGridUnitsForOtherAxis(config.grid_y)}
        sliderMax={MAX_GRID_UNITS}
        step={0.5}
        unit="u"
        onChange={(v) =>
          update({
              grid_x: v,
              partial_bins_values: createPartialBinsValues(v, config.grid_y),
          })
        }
        disabled={gridSizingMode === 'auto' || gridSizingMode === 'fixed_depth'}
      />

      <SliderRow
        label="Grid Depth"
        help="Bin depth in gridfinity units (42mm each). Half-unit increments (21mm) supported."
        value={config.grid_y}
        min={1}
        max={gridSizingMode === 'fixed_depth' ? MAX_GRID_UNITS : maxGridUnitsForOtherAxis(config.grid_x)}
        sliderMax={MAX_GRID_UNITS}
        step={0.5}
        unit="u"
        onChange={(v) => {
          const width = gridSizingMode === 'fixed_depth'
            ? Math.min(config.grid_x, maxGridUnitsForOtherAxis(v))
            : config.grid_x
          update({
            grid_x: width,
            grid_y: v,
            partial_bins_values: createPartialBinsValues(width, v),
          })
        }}
        disabled={gridSizingMode === 'auto'}
      />

      <SliderRow
        label="Height"
        help="Bin height in gridfinity units. Each unit is 7mm, including the base. The stacking lip and raised rim add height above this."
        value={config.height_units}
        min={1}
        max={20}
        unit="u"
        onChange={(v) => {
          const newMax = calcMaxCutoutDepth(v)
          update({ height_units: v, cutout_depth: Math.min(Math.max(5, config.cutout_depth), newMax) })
        }}
      />

      <div className="space-y-1.5 py-2">
        <label htmlFor={depthModeId} className="text-xs text-text-primary tracking-[0.3px]">
          Cutout depths
          <HelpTip text="Automatic derives each measured tool's shallowest depth that keeps it below the bin stacked on top. Uniform cuts one depth for every tool and keeps (but ignores) per-tool custom depths." />
        </label>
        <select
          id={depthModeId}
          aria-label="Cutout depths"
          value={config.cutout_depth_mode ?? 'legacy'}
          onChange={(e) => update({ cutout_depth_mode: e.target.value === 'legacy' ? null : e.target.value as 'automatic' | 'uniform' })}
          className="w-full rounded bg-elevated px-2 py-1.5 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
        >
          {config.cutout_depth_mode == null && (
            <option value="legacy">Existing per-tool depths</option>
          )}
          <option value="automatic">Automatic per tool</option>
          <option value="uniform">Uniform</option>
        </select>
        {config.cutout_depth_mode == null && (
          <p className="text-[11px] leading-tight text-text-muted">
            Existing per-tool depths is this bin’s saved behaviour from before depth modes.
            Choosing a mode applies it immediately; Undo restores the existing choice.
          </p>
        )}
      </div>

      {config.cutout_depth_mode === 'automatic' && (
        <SliderRow
          label="Stacking Clearance"
          help="Gap kept between each measured tool's top and the underside of the bin stacked on top. Automatic depths grow and shrink with it."
          value={config.stacking_clearance_mm}
          min={0}
          max={10}
          step={0.1}
          unit="mm"
          onChange={(v) => update({ stacking_clearance_mm: v })}
        />
      )}

      <SliderRow
        label="Cutout Depth"
        help={config.cutout_depth_mode === 'automatic'
          ? `Fallback depth for tools without a measured thickness. Max ${maxCutoutDepth.toFixed(2)}mm at ${config.height_units}u height.`
          : `How deep the tool pocket is cut into the bin. Max ${maxCutoutDepth.toFixed(2)}mm at ${config.height_units}u height.`}
        value={Math.min(Math.max(5, config.cutout_depth), maxCutoutDepth)}
        min={Math.min(5, maxCutoutDepth)}
        max={maxCutoutDepth}
        step={0.25}
        unit="mm"
        onChange={(v) => update({ cutout_depth: v })}
      />

      {config.cutout_depth_mode === 'uniform' && (
        <HintBanner>Per-tool custom depths are kept but ignored while Uniform is selected.</HintBanner>
      )}

      {maxCutoutDepth < 5 && (
        <HintBanner>A 1u bin leaves only 0.25mm for a pocket. Increase Height for a deeper cutout.</HintBanner>
      )}

      <SliderRow
        label="Clearance"
        help="Extra space around tool outlines. Increase if tools fit too tightly."
        value={config.cutout_clearance}
        min={0}
        max={5}
        step={0.1}
        unit="mm"
        onChange={(v) => update({ cutout_clearance: v })}
      />

      <SliderRow
        label="Cutout Chamfer"
        help="Bevel distance on the top edge of each tool pocket, in mm. 0 = sharp edge."
        value={config.cutout_chamfer}
        min={0}
        max={3}
        step={0.1}
        unit="mm"
        onChange={(v) => update({ cutout_chamfer: v })}
      />

      <div className="border-t border-border mt-2 pt-1">
        <Toggle
          checked={config.half_grid_base}
          onChange={(v) => update({ half_grid_base: v, ...(v ? { magnets: false } : {}) })}
          label="Half-grid base"
          help="Use 21mm half-grid cells on the baseplate instead of standard 42mm. Gives finer positioning on the baseplate."
        />
        <Toggle
          checked={config.magnets && !config.half_grid_base}
          onChange={(v) => update({ magnets: v })}
          label="Magnet holes"
          help="Holes in the base for magnets. Keeps bins locked to the baseplate."
          disabled={config.half_grid_base}
        />
        {config.half_grid_base && (
          <p className="text-[11px] text-text-muted mt-0.5 leading-tight pl-0.5">
            Magnet holes are not compatible with half-grid base cells
          </p>
        )}
        {config.magnets && !config.half_grid_base && (
          <div className="pl-3 border-l border-border-subtle ml-1 space-y-0">
            <SliderRow
              label="Diameter"
              value={config.magnet_diameter}
              min={3}
              max={10}
              step={0.5}
              unit="mm"
              onChange={(v) => update({ magnet_diameter: v })}
            />
            <SliderRow
              label="Depth"
              value={config.magnet_depth}
              min={1}
              max={5}
              step={0.1}
              unit="mm"
              onChange={(v) => update({ magnet_depth: v })}
            />
            <Toggle
              checked={config.magnet_corners_only}
              onChange={(v) => update({ magnet_corners_only: v })}
              label="Corners only"
              help="Only place magnet holes at the 4 outer corners of the bin."
            />
          </div>
        )}
        <Toggle
          checked={config.stacking_lip}
          onChange={(v) => {
            const newMax = calcMaxCutoutDepth(config.height_units)
            update({
              stacking_lip: v,
              rim_units: v ? config.rim_units : 0,
              cutout_depth: Math.min(Math.max(5, config.cutout_depth), newMax),
            })
          }}
          label="Stacking lip"
          help="Raised rim at the top so bins can stack securely on top of each other."
        />
        {config.stacking_lip && (
          <div className="pl-3 border-l border-border-subtle ml-1 space-y-0">
            <SliderRow
              label="Raise Lip"
              help="Extends the wall and lip this many units (7mm each) above the floor face, leaving the interior open. Lets a tool protrude above the floor while a stacked bin still clears it. 0 = standard."
              value={config.rim_units}
              min={0}
              max={10}
              unit="u"
              onChange={(v) => update({ rim_units: v })}
            />
          </div>
        )}
        <Toggle
          checked={config.insert_enabled}
          onChange={(v) => update({ insert_enabled: v })}
          label="Contrast Insert"
          help="Generates a separate insert STL to print in a contrasting colour. The pocket is deepened to accommodate it."
        />
        {config.insert_enabled && (
          <>
            <SliderRow
              label="Insert Height"
              help="Thickness of the insert in mm."
              value={config.insert_height}
              min={0.5}
              max={10}
              step={0.1}
              unit="mm"
              onChange={(v) => update({ insert_height: v })}
            />
            <SliderRow
              label="Insert Fit"
              help="Clearance shaved off the insert edges so it drops into the pocket."
              value={config.insert_clearance}
              min={0}
              max={1}
              step={0.05}
              unit="mm"
              onChange={(v) => update({ insert_clearance: v })}
            />
          </>
        )}
      </div>

      <div className="border-t border-border mt-2 pt-1">
        <SliderRow
          label="Bed Size"
          help="Print bed size. Bins wider than this are automatically split into pieces."
          value={config.bed_size}
          min={BED_SIZE_MIN_MM}
          max={BED_SIZE_MAX_MM}
          step={1}
          unit="mm"
          onChange={(v) => update({ bed_size: v })}
        />
        {needsSplit && (
          <HintBanner>
            {binWidth > config.bed_size && `Width ${binWidth}mm exceeds bed`}
            {binWidth > config.bed_size && binDepth > config.bed_size && ' & '}
            {binDepth > config.bed_size && `Depth ${binDepth}mm exceeds bed`}
            {' \u2014 will be split'}
          </HintBanner>
        )}
      </div>

      <div className="border-t border-border mt-2 pt-1">
          <Toggle
              checked={config.partial_bins}
              onChange={(v) =>
                  update({
                      partial_bins: v,
                      ...(!v ? { partial_bins_connect: false, partial_bins_retain_wall: false } : {}),
                  })
              }
              label="Partial Bins"
              help="Print only parts of the bin that are needed to hold the tools."
          />
          {config.partial_bins && (
              <div className="pl-3 border-l border-border-subtle ml-1 space-y-0">
                  <RadioMatrix sizeX={Math.ceil(config.grid_x)} sizeY={Math.ceil(config.grid_y)} values={config.partial_bins_values} onChange={(v) => update({ partial_bins_values: v })} />
                  <Toggle
                      checked={config.partial_bins_connect}
                      onChange={(v) =>
                          update({
                              partial_bins_connect: v,
                              ...(!v ? { partial_bins_retain_wall: false } : {}),
                          })
                      }
                      label="Connect base"
                      help="Remove walls in disabled cells, bridge them with a thin base plate, and keep one connected print."
                  />
                  {config.partial_bins_connect && (
                      <Toggle
                          checked={config.partial_bins_retain_wall}
                          onChange={(v) => update({ partial_bins_retain_wall: v })}
                          label="Retain outer wall"
                          help="Keep the bin perimeter wall through disabled cells while still connecting them on the base."
                      />
                  )}
                  {exportsSeparateParts && <HintBanner>Disconnected pieces {"\u2014"} export includes a ZIP with one STL per part</HintBanner>}
              </div>
          )}
      </div>
    </div>
  )
}

export function BinHeightPlanner({ binId, config, placedTools, onApply, onRemove }: {
  binId: string
  config: BinConfig
  placedTools: PlacedTool[]
  onApply: (proposal: HeightProposal) => Promise<void>
  onRemove: (id: string) => void
}) {
  const { theme } = useTheme()
  const fitDescriptionId = useId()
  const queryKey = ['bin-height-planning', binId, config, placedTools]
  const inputKey = hashKey(queryKey)
  const [settledInputKey, setSettledInputKey] = useState<string | null>(inputKey)
  const debouncing = inputKey !== settledInputKey
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const { data: planning, error: assessmentError, fetchStatus, refetch } = useQuery({
    queryKey,
    queryFn: () => planBinHeight(binId, config, placedTools),
    enabled: !debouncing,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  useEffect(() => {
    setApplyError(null)
    if (!debouncing) return
    setSettledInputKey(null)
    const timer = setTimeout(() => setSettledInputKey(inputKey), 200)
    return () => clearTimeout(timer)
  }, [inputKey, debouncing])
  useEffect(() => {
    const refresh = () => {
      if (!debouncing) void refetch({ cancelRefetch: false })
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [debouncing, refetch])

  const updating = debouncing || fetchStatus !== 'idle'
  const error = applyError ?? (assessmentError instanceof Error ? assessmentError.message : assessmentError ? 'Height assessment failed' : null)

  const proposal = planning?.alternatives.find(option => option.strategy === 'deeper_pockets')
  const canFit = !updating && !assessmentError && placedTools.length > 0 && proposal?.complete && proposal.bin_config && proposal.placed_tools
  const fitReason = placedTools.length === 0 ? 'Add tools to fit the bin height'
    : updating ? planning ? 'Updating tool fit before setting height' : 'Assessing tool fit'
    : assessmentError ? 'Height assessment failed; refresh to verify tool fit'
    : !planning ? 'Assessing tool fit'
    : !proposal?.complete && planning.assessment.missing_tool_ids.length > 0 ? 'Measure every tool’s thickness before auto-setting height'
    : proposal?.reason ?? 'Set the smallest bin height and pocket depths that fit all contained tools'

  return (
    <section className="glass rounded-[10px] p-3 text-[11px] text-text-secondary space-y-2" aria-label="Fit height to tools">
      <h3 className="font-semibold text-text-primary">Fit height to tools</h3>
      <ul className="space-y-2">
        {placedTools.map(placed => {
          const tool = planning?.assessment.envelopes.find(envelope => envelope.id === placed.id)
          const thickness = tool?.thickness_mm
          const depthViolations = planning?.assessment.violations.filter(violation => violation.tool_id === placed.tool_id) ?? []
          const invalid = tool && (!tool.seating_verified || depthViolations.length > 0 || (tool.clearance_mm !== null && tool.clearance_mm < -1e-7))
          const unknown = !tool || thickness == null || tool.clearance_mm === null
            || planning?.assessment.violations.some(violation => !violation.tool_id)
          const status = invalid ? 'Does not fit' : unknown ? 'Fit unknown' : 'Fits'
          const StatusIcon = invalid ? X : unknown ? CircleHelp : Check
          const depth = tool?.effective_depth_mm
          const clearance = tool?.clearance_mm
          const reason = depthViolations[0]?.message
            ?? (tool && !tool.seating_verified ? 'Reposition the tool or enlarge the bin to seat it in its pocket'
              : thickness == null ? 'Measure the tool’s thickness in its tool editor' : status)
          return (
            <li key={placed.id} className="flex items-center gap-1">
              <div className="flex-1 min-w-0">
                <a className="block break-words text-text-primary hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" href={`/tools/${placed.tool_id}`}>{tool?.name ?? placed.name}</a>
                <span className={cn('flex items-center gap-1 tabular-nums',
                  invalid ? theme === 'dark' ? 'text-red-400' : 'text-red-700'
                    : unknown ? theme === 'dark' ? 'text-amber-400' : 'text-amber-700'
                    : theme === 'dark' ? 'text-green-400' : 'text-green-700')}
                  title={reason} aria-label={status}>
                  <StatusIcon className="w-3 h-3 shrink-0" aria-hidden="true" />
                  {thickness == null ? '— mm · — u' : `${thickness} mm · ${Number((thickness / GF_HEIGHT_UNIT).toFixed(2))} u`}
                </span>
                {depth != null && (
                  <span className="block text-[10px] text-text-muted tabular-nums"
                    title="Calculated pocket depth and remaining clearance to the bin stacked above">
                    {`depth ${depth.toFixed(2)} mm · clearance ${clearance == null ? '—' : clearance.toFixed(2)} mm`}
                  </span>
                )}
              </div>
              <button type="button" aria-label={`Remove ${tool?.name ?? placed.name} from bin`}
                title="Remove from bin" disabled={applying} onClick={() => onRemove(placed.id)}
                className="w-7 h-7 shrink-0 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </li>
          )
        })}
      </ul>
      <button type="button" className="btn-secondary w-full px-2 py-1.5 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        disabled={!canFit || applying} title={fitReason} aria-describedby={fitDescriptionId}
        onClick={async () => {
          if (!canFit || !proposal || applying) return
          setApplying(true)
          try { await onApply(proposal) } catch (err) { setApplyError(err instanceof Error ? err.message : 'Could not set bin height') } finally { setApplying(false) }
        }}>
        {applying ? 'Setting height…' : updating && placedTools.length > 0 ? planning ? 'Updating fit…' : 'Checking fit…' : 'Auto-set bin height'}
      </button>
      <span id={fitDescriptionId} className="sr-only">{fitReason}</span>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
