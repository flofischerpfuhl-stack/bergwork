/**
 * Demo page: every component of @bergwork/ui in a berg:work Image window with mock data (no editor).
 * Layout after the Himmel:CAD Builder: title bar, a function bar island on top, side panels with a tab rail,
 * a status bar of islands at the bottom, everything floating over the work area with one gap.
 */
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Brush, Clock, Crop, Droplet, Eye, EyeOff, Hand, History, Image as ImageIcon, Layers, Lasso, Move, Palette, PenTool,
  Menu as MenuIcon, Pin, Redo2, Search, Shapes, SlidersHorizontal, SquareDashed, Stamp, Type, Undo2, Wand2, ZoomIn, Grid3x3, Ruler,
} from 'lucide-react';
import '../src/css/index.css';
import './demo.css';
import {
  Button, CheckMark, Chip, Dialog, IconButton, ListRow, MenuButton, NumberField, PropertyRow, Section, Segmented, Select,
  SidePanel, Slider, StateGlyph, TitleBar, TooltipLayer, useAppearance, useScrub, type MenuEntry, type ToggleState,
} from '../src';
import mark from './mark-image.svg';

const I = { size: 18, strokeWidth: 1.7 } as const;
const S = { size: 16, strokeWidth: 1.7 } as const;

const TOOLS = [
  { id: 'move', label: 'Move', key: 'V', icon: <Move {...I} /> },
  { id: 'marquee', label: 'Rectangular Marquee', key: 'M', icon: <SquareDashed {...I} />, more: true },
  { id: 'lasso', label: 'Lasso', key: 'L', icon: <Lasso {...I} />, more: true },
  { id: 'wand', label: 'Magic Wand', key: 'W', icon: <Wand2 {...I} />, more: true },
  { id: 'crop', label: 'Crop', key: 'C', icon: <Crop {...I} /> },
  { id: 'brush', label: 'Brush', key: 'B', icon: <Brush {...I} />, more: true },
  { id: 'stamp', label: 'Clone Stamp', key: 'S', icon: <Stamp {...I} /> },
  { id: 'blur', label: 'Smudge', key: 'R', icon: <Droplet {...I} />, more: true },
  { id: 'type', label: 'Text', key: 'T', icon: <Type {...I} /> },
  { id: 'pen', label: 'Pen', key: 'P', icon: <PenTool {...I} /> },
  { id: 'shape', label: 'Shape', key: 'U', icon: <Shapes {...I} />, more: true },
  { id: 'hand', label: 'Hand', key: 'H', icon: <Hand {...I} /> },
  { id: 'zoom', label: 'Zoom', key: 'Z', icon: <ZoomIn {...I} /> },
] as const;

interface Layer { id: string; name: string; meta: string; visible: boolean; filters?: string[] }
const LAYERS: Layer[] = [
  { id: 'title', name: 'Title', meta: 'Text', visible: true },
  { id: 'glow', name: 'Evening light', meta: 'Adjustment', visible: true },
  { id: 'photo', name: 'Mountains', meta: '1600 × 1083', visible: true, filters: ['Vignette', 'Tonal Contrast'] },
  { id: 'paper', name: 'Background', meta: '1600 × 1083', visible: true },
];

function Landscape() {
  return (
    <svg viewBox="0 0 1600 1083" className="demo-art" role="img" aria-label="Mountain landscape">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2b3a67" /><stop offset="0.55" stopColor="#c97b63" /><stop offset="1" stopColor="#f1c27d" /></linearGradient>
        <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d99a6c" /><stop offset="1" stopColor="#3b4a6b" /></linearGradient>
        <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75"><stop offset="0.6" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity="0.45" /></radialGradient>
      </defs>
      <rect width="1600" height="1083" fill="url(#sky)" />
      <circle cx="1120" cy="520" r="70" fill="#ffe2a8" opacity="0.9" />
      <path d="M0 640 L220 430 L360 540 L560 300 L760 560 L900 450 L1080 620 L1260 380 L1420 520 L1600 420 L1600 760 L0 760 Z" fill="#5a4a5e" />
      <path d="M560 300 L620 360 L590 370 L560 340 L530 372 L505 360 Z M1260 380 L1305 425 L1278 432 L1258 412 L1236 436 L1215 428 Z" fill="#efe6e1" />
      <path d="M0 720 L180 600 L330 680 L520 520 L700 690 L860 610 L1040 720 L1220 600 L1400 700 L1600 640 L1600 800 L0 800 Z" fill="#3f3546" />
      <rect y="790" width="1600" height="293" fill="url(#lake)" />
      <path d="M0 790 L1600 790" stroke="#f1c27d" strokeOpacity="0.5" strokeWidth="3" />
      <path d="M0 860 C 300 830, 500 900, 820 870 S 1300 840, 1600 880 L1600 1083 L0 1083 Z" fill="#2b2a3a" opacity="0.55" />
      <rect width="1600" height="1083" fill="url(#vignette)" />
      <text x="120" y="210" fill="#fff8ee" fontFamily="Inter Variable, sans-serif" fontSize="92" fontWeight="700" letterSpacing="2">ALPENGLOW</text>
    </svg>
  );
}

function App() {
  const [appearance, setAppearance] = useAppearance();
  const [tool, setTool] = useState('brush');
  const [leftTab, setLeftTab] = useState('layers');
  const [rightTab, setRightTab] = useState('properties');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [pin, setPin] = useState<ToggleState>('auto');
  const [selected, setSelected] = useState('photo');
  const [layers, setLayers] = useState(LAYERS);
  const [opacity, setOpacity] = useState(100);
  const [fill, setFill] = useState(100);
  const [blend, setBlend] = useState('normal');
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [angle, setAngle] = useState(0);
  const [sampling, setSampling] = useState<'smooth' | 'pixel'>('smooth');
  const [filters, setFilters] = useState<Record<string, boolean>>({ Vignette: true, 'Tonal Contrast': true });
  const [rulers, setRulers] = useState(true);
  const [grid, setGrid] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [width, setWidth] = useState(1600);
  const [height, setHeight] = useState(1083);
  const [resample, setResample] = useState('auto');
  const scrubOpacity = useScrub(opacity, setOpacity, { min: 0, max: 100 });

  const menus = useMemo((): { title: string; entries: MenuEntry[] }[] => [
    { title: 'File', entries: [
      { label: 'New Canvas…', shortcut: 'Ctrl+Alt+N' }, { label: 'Open…', shortcut: 'Ctrl+O' },
      { label: 'Open Recent', submenu: [{ label: 'mountains.bwimg' }, { label: 'autumn-poster.bwimg' }, { label: 'scan-0042.jpg' }] },
      { type: 'divider' }, { label: 'Import Images…' }, { label: 'Import Folder as Layers…' },
      { type: 'divider' }, { label: 'Save', shortcut: 'Ctrl+S' }, { label: 'Save As…', shortcut: 'Ctrl+Shift+S' },
      { label: 'Export As…', shortcut: 'Ctrl+Alt+Shift+W' },
    ] },
    { title: 'Edit', entries: [
      { label: 'Undo Vignette', shortcut: 'Ctrl+Z' }, { label: 'Redo', shortcut: 'Ctrl+Shift+Z', disabled: true, tip: 'Nothing to redo' },
      { type: 'divider' }, { label: 'Cut', shortcut: 'Ctrl+X', disabled: true, tip: 'No selection' }, { label: 'Copy', shortcut: 'Ctrl+C' },
      { label: 'Paste', shortcut: 'Ctrl+V' }, { type: 'divider' },
      { label: 'Transform', submenu: [{ label: 'Warp' }, { label: 'Perspective' }, { label: 'Distort' }] },
    ] },
    { title: 'Image', entries: [
      { label: 'Curves…', shortcut: 'Ctrl+M' }, { label: 'Levels…', shortcut: 'Ctrl+L' },
      { label: 'Hue/Saturation…', shortcut: 'Ctrl+U' }, { type: 'divider' },
      { label: 'Canvas Size…', shortcut: 'Ctrl+Alt+C' }, { label: 'Image Size…', shortcut: 'Ctrl+Alt+I', onSelect: () => setDialog(true) },
      { label: 'Trim…' },
      { label: 'Image Rotation', submenu: [{ label: '90° Clockwise' }, { label: '90° Counterclockwise' }, { label: '180°' }] },
    ] },
    { title: 'Layer', entries: [
      { label: 'New Blank Layer', shortcut: 'Ctrl+Shift+N' }, { label: 'Duplicate Layer', shortcut: 'Ctrl+J' },
      { type: 'divider' }, { label: 'Group Layers', shortcut: 'Ctrl+G' }, { label: 'Ungroup Layers', shortcut: 'Ctrl+Shift+G', disabled: true, tip: 'No folder selected' },
    ] },
    { title: 'Filter', entries: [
      { label: 'Last Filter: Vignette', shortcut: 'Ctrl+Alt+F' }, { type: 'divider' },
      { type: 'section', label: 'Blur' }, { label: 'Gaussian Blur…' }, { label: 'Progressive Blur…' },
      { type: 'section', label: 'Stylize' }, { label: 'Vignette…' }, { label: 'Bloom / Glow…' }, { label: 'RGB Split…' },
    ] },
    { title: 'View', entries: [
      { label: 'Search Commands…', shortcut: 'Ctrl+F' }, { type: 'divider' },
      { label: 'Rulers', shortcut: 'Ctrl+R', checked: rulers, onSelect: () => setRulers(!rulers) },
      { label: 'Grid', shortcut: "Ctrl+'", checked: grid, onSelect: () => setGrid(!grid) },
      { label: 'Snap To', checked: true, pale: true, submenu: [
        { label: 'Guides', checked: true }, { label: 'Layers', checked: true }, { label: 'Grid', checked: false }, { label: 'Canvas', checked: false },
      ] },
    ] },
  ], [rulers, grid]);

  const layer = layers.find((item) => item.id === selected);
  return (
    <div className="bw-window">
      <TitleBar mark={<img src={mark} alt="" width={20} height={20} />} product="Image" document="mountains.bwimg — 1600 × 1083"
        appearance={appearance} onAppearance={setAppearance} />
      <div className="bw-stage">
        <div className="demo-canvas" data-grid={grid}>
          <div className="demo-page"><Landscape /></div>
        </div>

        <div className="demo-functionbar bw-island bw-toolbar" role="toolbar" aria-label="Tools">
          <MenuButton className="bw-icon-button demo-compact-menu" label="Menu" tip="Menu"
            entries={menus.map((menu) => ({ label: menu.title, submenu: menu.entries }))}><MenuIcon {...I} /></MenuButton>
          {menus.map((menu) => (
            <MenuButton key={menu.title} className="demo-menu-button" label={menu.title} entries={menu.entries}>{menu.title}</MenuButton>
          ))}
          <span className="bw-divider" />
          {TOOLS.map((item) => (
            <IconButton key={item.id} icon={item.icon} label={item.label} shortcut={item.key} more={'more' in item}
              pressed={tool === item.id} onClick={() => setTool(item.id)} />
          ))}
          <span className="bw-divider" />
          <IconButton icon={<Search {...I} />} label="Search Commands" shortcut="Ctrl+F" />
        </div>

        {leftOpen ? (
          <SidePanel side="start" active={leftTab} onTab={setLeftTab}
            tabs={[{ id: 'layers', icon: <Layers {...I} />, label: 'Layers' }, { id: 'history', icon: <History {...I} />, label: 'History' }, { id: 'color', icon: <Palette {...I} />, label: 'Color' }]}
            railEnd={<IconButton icon={<Pin {...S} />} label="Pin" state={pin} small onClick={() => setPin(pin === 'off' ? 'auto' : pin === 'auto' ? 'on' : 'off')} />}
            toolbar={<>
              <IconButton icon={<Search {...S} />} label="Search layers" small />
              <MenuButton className="bw-icon-button is-small" label="New" tip="New layer, folder or adjustment layer"
                entries={[{ label: 'New Blank Layer' }, { label: 'New Folder' }, { type: 'divider' }, { label: 'Adjustment Layer', submenu: [{ label: 'Curves' }, { label: 'Hue/Saturation' }, { label: 'Black & White' }] }]}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>+</span>
              </MenuButton>
            </>}>
            {leftTab === 'layers' ? (
              <div className="bw-list" role="listbox" aria-label="Layers">
                {layers.map((item) => (
                  <div key={item.id}>
                    <ListRow name={item.name} meta={item.meta} selected={item.id === selected} onSelect={() => setSelected(item.id)}
                      thumb={item.id === 'photo' ? <span className="demo-thumb" /> : item.id === 'paper' ? <span className="demo-thumb is-paper" /> : <span className="demo-thumb is-text">{item.id === 'title' ? 'T' : '◐'}</span>}
                      end={<button type="button" className="bw-check" aria-label={item.visible ? 'Hide' : 'Show'} data-tip={item.visible ? 'Hide' : 'Show'}
                        onClick={(event) => { event.stopPropagation(); setLayers(layers.map((l) => l.id === item.id ? { ...l, visible: !l.visible } : l)); }}>
                        {item.visible ? <Eye {...S} /> : <EyeOff {...S} />}</button>} />
                    {item.filters?.map((name) => (
                      <ListRow key={name} child name={name} end={<CheckMark checked={!!filters[name]} label={name} onChange={(on) => setFilters({ ...filters, [name]: on })} />} />
                    ))}
                  </div>
                ))}
              </div>
            ) : <p className="bw-empty">{leftTab === 'history' ? 'No steps yet.' : 'Swatches follow.'}</p>}
          </SidePanel>
        ) : null}

        {rightOpen ? (
          <SidePanel side="end" active={rightTab} onTab={setRightTab}
            tabs={[{ id: 'properties', icon: <SlidersHorizontal {...I} />, label: 'Properties' }, { id: 'info', icon: <ImageIcon {...I} />, label: 'Image' }]}
            railEnd={<IconButton icon={<Pin {...S} />} label="Pin" state="on" small />}>
            {rightTab === 'properties' && layer ? (
              <>
                <div className="demo-summary">{layer.name} <span className="bw-list-meta">{layer.meta}</span></div>
                <Section id="demo.layer" title="Layer">
                  <PropertyRow label="Opacity" onLabelPointerDown={scrubOpacity}>
                    <Slider value={opacity} min={0} max={100} label="Opacity" onChange={setOpacity} />
                    <NumberField value={opacity} min={0} max={100} unit="%" label="Opacity" onChange={setOpacity} />
                  </PropertyRow>
                  <PropertyRow label="Fill">
                    <Slider value={fill} min={0} max={100} label="Fill" onChange={setFill} />
                    <NumberField value={fill} min={0} max={100} unit="%" label="Fill" onChange={setFill} />
                  </PropertyRow>
                  <PropertyRow label="Blend Mode">
                    <Select value={blend} label="Blend Mode" onChange={setBlend} options={[
                      { value: 'normal', label: 'Normal' }, { value: 'multiply', label: 'Multiply' }, { value: 'screen', label: 'Screen' },
                      { value: 'overlay', label: 'Overlay' }, { value: 'soft', label: 'Soft Light' }, { value: 'luminosity', label: 'Luminosity' }]} />
                  </PropertyRow>
                </Section>
                <Section id="demo.transform" title="Transform">
                  <PropertyRow label="X"><NumberField value={x} unit="px" label="X" onChange={setX} /></PropertyRow>
                  <PropertyRow label="Y"><NumberField value={y} unit="px" label="Y" onChange={setY} /></PropertyRow>
                  <PropertyRow label="Width"><span className="bw-row-text">1600 px</span></PropertyRow>
                  <PropertyRow label="Angle"><NumberField value={angle} unit="°" decimals={1} step={0.5} label="Angle" onChange={setAngle} /></PropertyRow>
                  <PropertyRow label="Sampling">
                    <Segmented value={sampling} label="Sampling" onChange={setSampling}
                      options={[{ value: 'smooth', label: 'Smooth', tip: 'High quality' }, { value: 'pixel', label: 'Pixel', tip: 'Nearest neighbour' }]} />
                  </PropertyRow>
                </Section>
                <Section id="demo.filters" title="Smart Filters">
                  {Object.entries(filters).map(([name, on]) => (
                    <PropertyRow key={name} label={name}><span className="bw-row-text demo-grow" />
                      <CheckMark checked={on} label={name} onChange={(next) => setFilters({ ...filters, [name]: next })} /></PropertyRow>
                  ))}
                  <PropertyRow label="Lock"><span className="demo-grow" />
                    <StateGlyph state="auto" label="Position locked (by folder)" pale onClick={() => {}} /></PropertyRow>
                </Section>
              </>
            ) : <p className="bw-empty">Image information follows.</p>}
          </SidePanel>
        ) : null}

        <div className="bw-statusbar">
          <div className="bw-statusbar-group">
            <div className="bw-island">
              <Chip icon={<Layers {...S} />} label="Layers" panel pressed={leftOpen} onClick={() => setLeftOpen(!leftOpen)} />
            </div>
            <div className="bw-island demo-phone-hide">
              <IconButton icon={<Undo2 {...S} />} label="Undo Vignette" shortcut="Ctrl+Z" small />
              <IconButton icon={<Redo2 {...S} />} label="Redo" shortcut="Ctrl+Shift+Z" small disabled />
              <IconButton icon={<Clock {...S} />} label="History" small />
            </div>
          </div>
          <div className="bw-island">
            <Chip readout value="61 %" tip="Zoom" width={70} />
            <span className="demo-phone-hide" style={{ display: 'contents' }}>
              <Chip readout value="1600 × 1083 px" tip="Image size" />
              <Chip readout value="sRGB · 8-bit" tip="Color space" />
            </span>
          </div>
          <div className="bw-statusbar-group is-end">
            <div className="bw-island demo-phone-hide">
              <Chip icon={<Ruler {...S} />} tip="Guides and rulers" count={rulers ? 3 : 0}
                menu={[{ label: 'Rulers', checked: rulers, onSelect: () => setRulers(!rulers) }, { label: 'Show Guides', checked: true }, { label: 'Lock Guides', checked: false }]} />
              <Chip icon={<Grid3x3 {...S} />} tip="Grid" count={grid ? 1 : 0} menu={[{ label: 'Grid', checked: grid, onSelect: () => setGrid(!grid) }, { label: 'Pixel Grid from 800 %', checked: true }]} />
            </div>
            <div className="bw-island">
              <Chip icon={<SlidersHorizontal {...S} />} label="Properties" panel pressed={rightOpen} onClick={() => setRightOpen(!rightOpen)} />
            </div>
          </div>
        </div>
      </div>

      {dialog ? (
        <Dialog title="Image Size" onCancel={() => setDialog(false)} onSubmit={() => setDialog(false)}
          buttons={<><Button variant="quiet" onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary" type="submit">Apply</Button></>}>
          <PropertyRow label="Width"><NumberField value={width} min={1} max={30000} unit="px" label="Width" onChange={(v) => { setHeight(Math.round(v * 1083 / 1600)); setWidth(v); }} /></PropertyRow>
          <PropertyRow label="Height"><NumberField value={height} min={1} max={30000} unit="px" label="Height" onChange={(v) => { setWidth(Math.round(v * 1600 / 1083)); setHeight(v); }} /></PropertyRow>
          <PropertyRow label="Resample">
            <Select value={resample} label="Resample" onChange={setResample} options={[{ value: 'auto', label: 'Automatic' }, { value: 'bicubic', label: 'Bicubic' }, { value: 'nearest', label: 'Nearest Neighbour' }]} />
          </PropertyRow>
          <PropertyRow label="Constrain"><span className="demo-grow" /><CheckMark checked label="Constrain proportions" /></PropertyRow>
        </Dialog>
      ) : null}
      <TooltipLayer />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
