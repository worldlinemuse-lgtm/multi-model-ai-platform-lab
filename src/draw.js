// Brush engine for the media workbench drawing layer.
// Art-tool lessons applied: the dab is the atom, presets are data (not code),
// pulled-string smoothing for line work, speed-sensitive dab spacing.

export const BRUSH_PRESETS = {  pencil:  { name:'Pencil',     tip:'hard',   sizeMul:1,   opacityMul:1,   flow:1,   spacing:0.12, smoothing:0,    pressureSize:true,  pressureOpacity:false, eraser:false },
  ink:     { name:'Ink pen',    tip:'hard',   sizeMul:1,   opacityMul:1,   flow:1,   spacing:0.10, smoothing:0.65, pressureSize:true,  pressureOpacity:true,  eraser:false },
  marker:  { name:'Marker',     tip:'soft',   sizeMul:2.2, opacityMul:0.55,flow:0.9, spacing:0.08, smoothing:0.25, pressureSize:false, pressureOpacity:false, eraser:false },
  soft:    { name:'Soft brush', tip:'soft',   sizeMul:3,   opacityMul:0.35,flow:0.5, spacing:0.06, smoothing:0.4,  pressureSize:true,  pressureOpacity:true,  eraser:false },
  eraser:  { name:'Eraser',     tip:'soft',   sizeMul:2.5, opacityMul:1,   flow:1,   spacing:0.08, smoothing:0.3,  pressureSize:true,  pressureOpacity:false, eraser:true },
  smudge:  { name:'Smudge',     tip:'soft',   sizeMul:2,   opacityMul:0.5,  flow:0.6, spacing:0.05, smoothing:0.35, pressureSize:true,  pressureOpacity:false, eraser:false, smudge:true },
};

export const BLEND_MODES = ['source-over','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity'];

export const DEFAULT_SMOOTHING = Object.fromEntries(
  Object.entries(BRUSH_PRESETS).map(([id,p])=>[p.name, p.smoothing]));

function hexToRgba(hex, a){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex||'');
  if(!m) return `rgba(0,0,0,${a})`;
  const n = parseInt(m[1],16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
function rng32(seed){let a=seed>>>0;return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

export class BrushEngine {
  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.preset = BRUSH_PRESETS.pencil;
    this.color = '#ff3b30';
    this.blendMode = 'source-over';
    this.sampleSource = null;  // canvas to sample photo color from (for smudge)
    this.size = 8;
    this.opacity = 1;
    this.strokes = [];       // committed stroke snapshots for undo
    this.drawing = false;
    this._reset();
  }
  setPreset(id){ if(BRUSH_PRESETS[id]) this.preset = BRUSH_PRESETS[id]; }
  _reset(){
    this.tip = null;         // pulled-string tip position
    this.lastDab = null;
    this.seed = (Math.random()*0xFFFFFFFF)>>>0;
    this.rand = rng32(this.seed);
    this.dabCount = 0;
    this._pickup = null;
  }
  resize(w,h){
    // Preserve existing drawing across resizes.
    const old = document.createElement('canvas');
    old.width = this.canvas.width; old.height = this.canvas.height;
    if(old.width>0 && old.height>0) old.getContext('2d').drawImage(this.canvas,0,0);
    this.canvas.width = w; this.canvas.height = h;
    this.ctx.clearRect(0,0,w,h);
    if(old.width>0 && old.height>0) this.ctx.drawImage(old,0,0,w,h);
  }
  clear(){ this.strokes.push(this._snapshot()); this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height); }
  undo(){
    const prev = this.strokes.pop();
    if(!prev) return false;
    this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
    if(prev.w>0) this.ctx.drawImage(prev.canvas,0,0);
    return true;
  }
  _snapshot(){
    const c = document.createElement('canvas');
    c.width = this.canvas.width; c.height = this.canvas.height;
    if(c.width>0) c.getContext('2d').drawImage(this.canvas,0,0);
    return { canvas:c, w:c.width };
  }
  beginStroke(x,y,pressure){
    if(this.drawing) return;
    this.drawing = true;
    this.strokes.push(this._snapshot());
    if(this.strokes.length>30) this.strokes.shift();
    this._reset();
    this.tip = { x, y };
    this._dab(x,y,pressure);
  }
  moveStroke(x,y,pressure){
    if(!this.drawing || !this.tip) return;
    // Pulled-string smoothing: tip chases the pointer.
    const s = this.preset.smoothing;
    const tx = this.tip.x + (x - this.tip.x) * (1 - s);
    const ty = this.tip.y + (y - this.tip.y) * (1 - s);
    // Speed-sensitive spacing: walk from tip toward target, dabbing along the way.
    const dx = tx - this.tip.x, dy = ty - this.tip.y;
    const dist = Math.hypot(dx,dy);
    const size = this._size(pressure);
    const step = Math.max(size * this.preset.spacing, 0.75);
    if(dist >= step){
      const n = Math.floor(dist/step);
      for(let i=1;i<=n;i++){
        const px = this.tip.x + dx*(i/n), py = this.tip.y + dy*(i/n);
        this._dab(px,py,pressure);
      }
      this.tip = { x:tx, y:ty };
    }
  }
  endStroke(){ this.drawing = false; this.tip = null; }
  _size(pressure){
    const p = this.preset;
    const pr = p.pressureSize ? (0.25 + 0.75*(pressure||0.5)) : 1;
    return Math.max(1, this.size * p.sizeMul * pr);
  }
  _dab(x,y,pressure){
    const p = this.preset, ctx = this.ctx;
    const size = this._size(pressure);
    const pr = p.pressureOpacity ? (0.3 + 0.7*(pressure||0.5)) : 1;
    const alpha = Math.min(1, this.opacity * p.opacityMul * p.flow * pr);
    let paintColor = this.color;
    if(p.smudge && this.sampleSource && this.sampleSource.width>0){
      try{
        const sx = Math.max(0, Math.min(this.sampleSource.width-1, Math.round(x)));
        const sy = Math.max(0, Math.min(this.sampleSource.height-1, Math.round(y)));
        const d = this.sampleSource.getContext('2d').getImageData(sx, sy, 1, 1).data;
        // Mix sampled photo color with current pickup (wet-paint feel): pickup drifts toward canvas.
        const mixAmt = 0.45;
        const cur = this._pickup || [d[0],d[1],d[2]];
        const mixed = [0,1,2].map(i=>Math.round(cur[i]+(d[i]-cur[i])*mixAmt));
        this._pickup = mixed;
        paintColor = `rgb(${mixed[0]},${mixed[1]},${mixed[2]})`;
      }catch{}
    } else if(!p.smudge){ this._pickup = null; }
    // Seeded jitter: same stroke replays identically.
    const jx = (this.rand()-0.5) * size * 0.06;
    const jy = (this.rand()-0.5) * size * 0.06;
    ctx.save();
    ctx.globalCompositeOperation = p.eraser ? 'destination-out' : this.blendMode;
    ctx.globalAlpha = alpha;
    const r = size/2;
    ctx.beginPath();
    ctx.arc(x+jx, y+jy, r, 0, Math.PI*2);
    if(p.tip==='soft'){
      const g = ctx.createRadialGradient(x+jx,y+jy,0,x+jx,y+jy,r);
      g.addColorStop(0, paintColor);
      g.addColorStop(0.65, paintColor);
      g.addColorStop(1, hexToRgba(paintColor, 0));
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = paintColor;
    }
    ctx.fill();
    ctx.restore();
    this.dabCount++;
    this.lastDab = { x, y };
  }
}
