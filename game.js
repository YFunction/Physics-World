/* ============================================
   电磁学物理沙盒《场》— 阶段一+二+三：静电+磁场+时变场沙盒
   核心物理引擎 + 元件系统 + 可视化
   ============================================ */

// ==================== DOM 引用 ====================
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// ==================== 画布尺寸 ====================
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// ==================== 物理常量 & 配置 ====================
const K = 300000;            // 库仑常数（缩放适配像素坐标）
const MU0 = 15000;           // 磁常数（缩放适配像素坐标）
const DT = 0.016;          // 物理时间步长 (~60fps)
const SOFTENING = 100;     // 力软化半径平方（防奇点）
const DAMPING = 0.995;     // 速度阻尼
const MIN_VELOCITY = 0.01; // 最小速度阈值

// 可视化配置
const FIELD_GRID_STEP = 45;    // 电场箭头网格间距
const BFIELD_GRID_STEP = 50;   // 磁场箭头网格间距
const ARROW_SCALE = 16;        // 电场箭头基础长度
const BARROW_SCALE = 18;       // 磁场箭头基础长度
const EQUIPOTENTIAL_LEVELS = 16; // 等势面层级数

// 时变场配置
const INDUCED_FIELD_GRID = 35; // 感应场计算网格
const EPSILON0 = 1 / K;        // 真空介电常数（单位制自洽）

// ==================== 时变场：时间 & 波形系统 ====================
let simTime = 0;               // 模拟时间（秒）

// 波形发生器：返回当前振幅因子 [-1, 1]
function waveform(shape, frequency, phase, t, duty = 0.5) {
    const omega = 2 * Math.PI * frequency;
    const angle = omega * t + phase;
    switch (shape) {
        case "sine":
            return Math.sin(angle);
        case "square":
            return Math.sin(angle) >= 0 ? 1 : -1;
        case "triangle":
            // triangle wave: 2*|2*(t/T - floor(t/T+0.5))| - 1
            const tp = (t * frequency + phase / (2 * Math.PI)) % 1;
            return 4 * Math.abs(tp - 0.5) - 1;
        case "sawtooth":
            return 2 * ((t * frequency + phase / (2 * Math.PI)) % 1) - 1;
        case "pulse":
            return ((t * frequency + phase / (2 * Math.PI)) % 1) < duty ? 1 : 0;
        default:
            return Math.sin(angle);
    }
}

// 数值微分：计算某量Q在点(x,y)处对时间的偏导数 ∂Q/∂t
// 用于计算位移电流 (∂E/∂t) 和磁通变化率 (∂B/∂t)
const DT_DERIV = 0.001; // 数值微分的时间步长

// ==================== 全局状态 ====================
let paused = false;
let showFieldLines = true;
let showEquipotential = true;
let showBFieldLines = true;
let showGrid = true;
let currentTool = "charge-positive";
let selectedObject = null;
let hoveredObject = null;
let mouseX = 0;
let mouseY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let platePlaceStart = null;  // 放置平板时的起始点
let magnetPlaceAngle = 0;    // 放置磁铁时的角度（右键旋转）

// 物体列表
let charges = [];        // 点电荷
let plates = [];         // 带电平板
let metalBalls = [];     // 金属导体球
let insulators = [];     // 绝缘块
let probes = [];         // 探针（电场/电势/磁场）
let barMagnets = [];     // 条形永磁铁
let electromagnets = []; // 电磁铁
let helmholtzCoils = []; // 亥姆霍兹线圈对
let ironCores = [];      // 铁芯/磁轭
let uniformBFields = []; // 均匀磁场区域（方形/圆形）

// 阶段三：时变场元件
let oscEDipoles = [];      // 交变电偶极子
let oscMDipoles = [];      // 交变磁偶极子
let timeVaryingEFields = []; // 时变匀强电场区域
let timeVaryingBFields = []; // 时变匀强磁场区域
let eddyRings = [];        // 涡流环（被动感应体）
let polarDisks = [];       // 极化涡旋盘（位移电流感应体）

// 阶段三：新探针
let inducedProbes = [];    // 感生场探针（区分库仑场/感生场分量）
let dispCurrentProbes = [];// 位移电流密度探针 ∂E/∂t
let fluxProbes = [];       // 磁通变化率探针 dΦ_B/dt

// 显示选项
let showInducedFields = true;   // 涡旋场可视化
let showPoyntingPreview = false;// 坡印廷矢量预览（阶段三暂为基础版）

// 工具历史（用于区分新旧物体）
let objectIdCounter = 0;
function nextId() { return ++objectIdCounter; }

// ==================== 工具函数 ====================
function dist2(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return dx * dx + dy * dy;
}

function dist(x1, y1, x2, y2) {
    return Math.sqrt(dist2(x1, y1, x2, y2));
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

// 电场颜色映射：根据强度映射到颜色
function fieldColor(strength) {
    // 将场强映射到 HSL：低=蓝紫，中=青，高=黄白
    const t = Math.min(strength / 5.0, 1.0);
    const h = 0.6 - t * 0.55; // 蓝色(0.6) → 红色(0.05)
    const s = 0.8;
    const l = 0.35 + t * 0.45;
    return `hsl(${h * 360}, ${s * 100}%, ${l * 100}%)`;
}

// 电势颜色映射
function potentialColor(v, vMin, vMax) {
    if (vMax - vMin < 1e-6) return "rgba(128,128,128,0.3)";
    const t = (v - vMin) / (vMax - vMin);
    // 负电势=蓝，零=灰，正电势=红
    if (t < 0.5) {
        const s = t * 2;
        return `rgba(${Math.round(40 + s*60)}, ${Math.round(80 + s*100)}, ${Math.round(200 - s*60)}, 0.35)`;
    } else {
        const s = (t - 0.5) * 2;
        return `rgba(${Math.round(100 + s*155)}, ${Math.round(180 - s*140)}, ${Math.round(140 - s*100)}, 0.35)`;
    }
}

// ==================== 物理计算核心 ====================

/**
 * 计算某点的总电场（叠加原理）
 * @returns {{ex: number, ey: number}}
 */
function computeElectricField(x, y, excludeObj = null) {
    let ex = 0, ey = 0;

    // 点电荷贡献
    for (const c of charges) {
        if (c === excludeObj) continue;
        const dx = x - c.x;
        const dy = y - c.y;
        const r2 = dx * dx + dy * dy;
        if (r2 < 1) continue;
        const r = Math.sqrt(r2);
        const E = K * c.q / r2;
        ex += E * dx / r;
        ey += E * dy / r;
    }

    // 带电平板贡献（采样近似）
    for (const p of plates) {
        if (p === excludeObj) continue;
        const sampleContrib = p.getFieldAt(x, y);
        ex += sampleContrib.ex;
        ey += sampleContrib.ey;
    }

    // 金属球贡献（含感应电荷）
    for (const mb of metalBalls) {
        if (mb === excludeObj) continue;
        const contrib = mb.getFieldAt(x, y);
        ex += contrib.ex;
        ey += contrib.ey;
    }

    // 绝缘体贡献（如果带电）
    for (const ins of insulators) {
        if (ins === excludeObj || ins.q === 0) continue;
        const dx = x - ins.x;
        const dy = y - ins.y;
        const r2 = dx * dx + dy * dy;
        if (r2 < 1) continue;
        const r = Math.sqrt(r2);
        const E = K * ins.q / r2;
        ex += E * dx / r;
        ey += E * dy / r;
    }

    // ---- 阶段三：法拉第感应电场（时变B → 涡旋E） ----
    // 交变磁偶极子贡献
    for (const omd of oscMDipoles) {
        if (omd === excludeObj) continue;
        const contrib = omd.getInducedEFieldAt(x, y);
        ex += contrib.ex;
        ey += contrib.ey;
    }

    // 时变匀强B场区域贡献
    for (const tvb of timeVaryingBFields) {
        if (tvb === excludeObj) continue;
        const contrib = tvb.getInducedEFieldAt(x, y);
        ex += contrib.ex;
        ey += contrib.ey;
    }

    // 涡流环（被动感应体）产生的二次感应电场
    for (const er of eddyRings) {
        if (er === excludeObj) continue;
        const contrib = er.getInducedFieldAt(x, y);
        ex += contrib.ex;
        ey += contrib.ey;
    }

    // 时变匀强E场区域贡献（库仑型，但随时间变化）
    for (const tve of timeVaryingEFields) {
        if (tve === excludeObj) continue;
        const contrib = tve.getFieldAt(x, y);
        ex += contrib.ex;
        ey += contrib.ey;
    }

    // 交变电偶极子贡献（时变库仑场）
    for (const oed of oscEDipoles) {
        if (oed === excludeObj) continue;
        const contrib = oed.getFieldAt(x, y);
        ex += contrib.ex;
        ey += contrib.ey;
    }

    return { ex, ey };
}

/**
 * 计算某点的电势（标量叠加）
 */
function computePotential(x, y, excludeObj = null) {
    let V = 0;

    for (const c of charges) {
        if (c === excludeObj) continue;
        const d = dist(x, y, c.x, c.y);
        if (d < 1) continue;
        V += K * c.q / d;
    }

    for (const p of plates) {
        if (p === excludeObj) continue;
        V += p.getPotentialAt(x, y);
    }

    for (const mb of metalBalls) {
        if (mb === excludeObj) continue;
        V += mb.getPotentialAt(x, y);
    }

    for (const ins of insulators) {
        if (ins === excludeObj || ins.q === 0) continue;
        const d = dist(x, y, ins.x, ins.y);
        if (d < 1) continue;
        V += K * ins.q / d;
    }

    return V;
}

/**
 * 计算某点受到的库仑力
 */
function computeCoulombForce(obj) {
    const { ex, ey } = computeElectricField(obj.x, obj.y, obj);
    return { fx: ex * obj.q, fy: ey * obj.q };
}

/**
 * 计算某点的总磁场（叠加原理）
 * @returns {{bx: number, by: number, bz: number}}
 */
function computeMagneticField(x, y, excludeObj = null) {
    let bx = 0, by = 0, bz = 0;

    // 永磁铁贡献（磁偶极子场）
    for (const bm of barMagnets) {
        if (bm === excludeObj) continue;
        const contrib = bm.getFieldAt(x, y);
        bx += contrib.bx;
        by += contrib.by;
        bz += contrib.bz;
    }

    // 电磁铁贡献
    for (const em of electromagnets) {
        if (em === excludeObj || !em.active) continue;
        const contrib = em.getFieldAt(x, y);
        bx += contrib.bx;
        by += contrib.by;
        bz += contrib.bz;
    }

    // 亥姆霍兹线圈贡献
    for (const hc of helmholtzCoils) {
        if (hc === excludeObj) continue;
        const contrib = hc.getFieldAt(x, y);
        bx += contrib.bx;
        by += contrib.by;
        bz += contrib.bz;
    }

    // 铁芯导磁效应（增强附近磁场）
    for (const ic of ironCores) {
        if (ic === excludeObj) continue;
        const contrib = ic.getFieldModification(x, y, bx, by, bz);
        bx = contrib.bx;
        by = contrib.by;
        bz = contrib.bz;
    }

    // 均匀磁场区域（方形/圆形）
    for (const ubf of uniformBFields) {
        if (ubf === excludeObj) continue;
        const contrib = ubf.getFieldAt(x, y);
        bx += contrib.bx;
        by += contrib.by;
        bz += contrib.bz;
    }

    // ---- 阶段三：位移电流感生磁场（时变E → 感生B） ----
    // 交变电偶极子的位移电流贡献
    for (const oed of oscEDipoles) {
        if (oed === excludeObj) continue;
        const contrib = oed.getDisplacementBFieldAt(x, y);
        bx += contrib.bx;
        by += contrib.by;
        bz += contrib.bz;
    }

    // 时变匀强E场区域的位移电流贡献
    for (const tve of timeVaryingEFields) {
        if (tve === excludeObj) continue;
        const contrib = tve.getDisplacementBFieldAt(x, y);
        bx += contrib.bx;
        by += contrib.by;
        bz += contrib.bz;
    }

    // 极化涡旋盘（被动感应体）产生的二次感生磁场
    for (const pd of polarDisks) {
        if (pd === excludeObj) continue;
        const contrib = pd.getInducedFieldAt(x, y);
        bx += contrib.bx;
        by += contrib.by;
        bz += contrib.bz;
    }

    // 交变磁偶极子的磁场贡献
    for (const omd of oscMDipoles) {
        if (omd === excludeObj) continue;
        const contrib = omd.getFieldAt(x, y);
        bx += contrib.bx;
        by += contrib.by;
        bz += contrib.bz;
    }

    // 时变匀强B场区域贡献
    for (const tvb of timeVaryingBFields) {
        if (tvb === excludeObj) continue;
        const contrib = tvb.getFieldAt(x, y);
        bx += contrib.bx;
        by += contrib.by;
        bz += contrib.bz;
    }

    return { bx, by, bz };
}

// ==================== 元件类 ====================

// ---- 点电荷 ----
class Charge {
    constructor(x, y, q, fixed = false) {
        this.id = nextId();
        this.type = "charge";
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        this.q = q;             // 电量（可正可负）
        this.mass = Math.abs(q) * 1.0;
        this.radius = 10 + Math.abs(q) * 3;
        this.fixed = fixed;     // 固定电荷不移动
        this.dragging = false;
    }

    update() {
        if (this.dragging || this.fixed) return;

        const { fx, fy } = computeCoulombForce(this);

        // 洛伦兹力：F = q(v × B)，2D中只Bz分量产生面内力
        const B = computeMagneticField(this.x, this.y, this);
        const lorentzFx = this.q * (this.vy * B.bz);
        const lorentzFy = this.q * (-this.vx * B.bz);

        const ax = (fx + lorentzFx) / this.mass;
        const ay = (fy + lorentzFy) / this.mass;

        this.vx += ax * DT;
        this.vy += ay * DT;

        // 阻尼
        this.vx *= DAMPING;
        this.vy *= DAMPING;

        // 低速归零
        if (Math.abs(this.vx) < MIN_VELOCITY && Math.abs(this.vy) < MIN_VELOCITY) {
            if (Math.abs(ax) < 0.1 && Math.abs(ay) < 0.1) {
                this.vx = 0;
                this.vy = 0;
            }
        }

        this.x += this.vx * DT;
        this.y += this.vy * DT;

        // 边界碰撞
        this.boundaryBounce();
    }

    boundaryBounce() {
        if (this.x < this.radius) {
            this.x = this.radius;
            this.vx *= -0.5;
        }
        if (this.x > canvas.width - this.radius) {
            this.x = canvas.width - this.radius;
            this.vx *= -0.5;
        }
        if (this.y < this.radius) {
            this.y = this.radius;
            this.vy *= -0.5;
        }
        if (this.y > canvas.height - this.radius) {
            this.y = canvas.height - this.radius;
            this.vy *= -0.5;
        }
    }

    draw(ctx) {
        // 光晕
        const glowRadius = this.radius + 6;
        const glowGrad = ctx.createRadialGradient(this.x, this.y, this.radius * 0.5,
            this.x, this.y, glowRadius);
        const baseColor = this.q > 0 ? "255, 80, 60" : "60, 120, 255";
        glowGrad.addColorStop(0, `rgba(${baseColor}, 0.6)`);
        glowGrad.addColorStop(1, `rgba(${baseColor}, 0)`);
        ctx.beginPath();
        ctx.arc(this.x, this.y, glowRadius, 0, Math.PI * 2);
        ctx.fillStyle = glowGrad;
        ctx.fill();

        // 主体
        const bodyGrad = ctx.createRadialGradient(
            this.x - this.radius * 0.25, this.y - this.radius * 0.25, this.radius * 0.1,
            this.x, this.y, this.radius);
        if (this.q > 0) {
            bodyGrad.addColorStop(0, "#ff9999");
            bodyGrad.addColorStop(0.6, "#cc2222");
            bodyGrad.addColorStop(1, "#881111");
        } else {
            bodyGrad.addColorStop(0, "#99bbff");
            bodyGrad.addColorStop(0.6, "#3366cc");
            bodyGrad.addColorStop(1, "#113388");
        }
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = bodyGrad;
        ctx.fill();

        // 边框
        ctx.strokeStyle = this.q > 0 ? "rgba(255,150,130,0.6)" : "rgba(130,170,255,0.6)";
        ctx.lineWidth = this.fixed ? 2 : 1;
        ctx.stroke();

        // 固定标记
        if (this.fixed) {
            ctx.strokeStyle = "rgba(255,255,255,0.5)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius + 4, 0, Math.PI * 2);
            ctx.setLineDash([3, 3]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 符号
        ctx.fillStyle = "white";
        ctx.font = `bold ${Math.max(11, this.radius * 0.85)}px "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const sign = this.q > 0 ? "+" : "−";
        ctx.fillText(sign, this.x, this.y);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius + 5, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    containsPoint(px, py) {
        return dist2(px, py, this.x, this.y) <= (this.radius + 5) ** 2;
    }
}

// ---- 带电平板 ----
class ChargedPlate {
    constructor(x, y, w, h, sigma, angle = 0) {
        this.id = nextId();
        this.type = "plate";
        this.x = x;
        this.y = y;
        this.w = w;         // 宽度
        this.h = h;         // 高度
        this.sigma = sigma; // 面电荷密度
        this.angle = angle; // 旋转角度
        this.fixed = true;
        this.dragging = false;

        // 采样点（用于场计算）
        this.samplePoints = [];
        this.generateSamples();
    }

    generateSamples() {
        this.samplePoints = [];
        const nx = Math.max(3, Math.floor(this.w / 18));
        const ny = Math.max(3, Math.floor(this.h / 18));
        const totalQ = this.sigma * this.w * this.h;
        const qPerSample = totalQ / (nx * ny);

        for (let i = 0; i < nx; i++) {
            for (let j = 0; j < ny; j++) {
                const lx = (i + 0.5) / nx * this.w - this.w / 2;
                const ly = (j + 0.5) / ny * this.h - this.h / 2;
                // 旋转
                const cos = Math.cos(this.angle);
                const sin = Math.sin(this.angle);
                const rx = lx * cos - ly * sin;
                const ry = lx * sin + ly * cos;
                this.samplePoints.push({
                    x: this.x + rx,
                    y: this.y + ry,
                    q: qPerSample
                });
            }
        }
    }

    getFieldAt(x, y) {
        let ex = 0, ey = 0;
        for (const sp of this.samplePoints) {
            const dx = x - sp.x;
            const dy = y - sp.y;
            const r2 = dx * dx + dy * dy;
            if (r2 < 1) continue;
            const r = Math.sqrt(r2);
            const E = K * sp.q / r2;
            ex += E * dx / r;
            ey += E * dy / r;
        }
        return { ex, ey };
    }

    getPotentialAt(x, y) {
        let V = 0;
        for (const sp of this.samplePoints) {
            const d = dist(x, y, sp.x, sp.y);
            if (d < 1) continue;
            V += K * sp.q / d;
        }
        return V;
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // 主体
        const grad = ctx.createLinearGradient(0, -this.h / 2, 0, this.h / 2);
        if (this.sigma > 0) {
            grad.addColorStop(0, "#cc4444");
            grad.addColorStop(0.5, "#ff6666");
            grad.addColorStop(1, "#aa2222");
        } else if (this.sigma < 0) {
            grad.addColorStop(0, "#3366cc");
            grad.addColorStop(0.5, "#5588ee");
            grad.addColorStop(1, "#2244aa");
        } else {
            grad.addColorStop(0, "#555");
            grad.addColorStop(1, "#444");
        }
        ctx.fillStyle = grad;
        ctx.fillRect(-this.w / 2, -this.h / 2, this.w, this.h);

        // 边框
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-this.w / 2, -this.h / 2, this.w, this.h);

        // 电荷密度标记
        ctx.fillStyle = "white";
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`σ=${this.sigma.toFixed(1)}`, 0, 0);

        ctx.restore();

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.rotate(this.angle);
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.strokeRect(-this.w / 2 - 3, -this.h / 2 - 3, this.w + 6, this.h + 6);
            ctx.restore();
        }
    }

    containsPoint(px, py) {
        // 逆变换
        const cos = Math.cos(-this.angle);
        const sin = Math.sin(-this.angle);
        const dx = px - this.x;
        const dy = py - this.y;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        return Math.abs(lx) <= this.w / 2 + 5 && Math.abs(ly) <= this.h / 2 + 5;
    }
}

// ---- 金属导体球 ----
class MetalBall {
    constructor(x, y, radius) {
        this.id = nextId();
        this.type = "metalBall";
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.fixed = true;
        this.dragging = false;
        this.q = 0;           // 净电荷（可注入）
        // 感应偶极矩
        this.inducedPx = 0;
        this.inducedPy = 0;
    }

    updateInduced() {
        // 计算球心处的外部电场
        const Eext = computeElectricField(this.x, this.y, this);
        // 导体球在均匀外场中的感应偶极矩: p = 4πε₀ R³ Eext
        // 在我们的单位制中 ε₀=1, 所以 p = 4 * R³ * Eext
        const R3 = this.radius ** 3;
        this.inducedPx = 4 * R3 * Eext.ex;
        this.inducedPy = 4 * R3 * Eext.ey;
    }

    getFieldAt(x, y) {
        // 净电荷 + 感应偶极子的场
        let ex = 0, ey = 0;

        // 净电荷贡献
        if (this.q !== 0) {
            const dx = x - this.x;
            const dy = y - this.y;
            const r2 = dx * dx + dy * dy;
            if (r2 >= this.radius * this.radius) {
                const r = Math.sqrt(r2);
                const E = K * this.q / r2;
                ex += E * dx / r;
                ey += E * dy / r;
            }
        }

        // 感应偶极子贡献（仅在球外）
        const dx = x - this.x;
        const dy = y - this.y;
        const r2 = dx * dx + dy * dy;
        if (r2 >= this.radius * this.radius) {
            const r = Math.sqrt(r2);
            const r3 = r2 * r;
            const r5 = r3 * r2;
            const pDotR = this.inducedPx * dx + this.inducedPy * dy;
            // 偶极子电场: E = (3(p·r̂)r̂ - p) / (4πε₀ r³)
            // 这里省略 1/(4πε₀) 因为已包含在 K 中
            ex += (3 * pDotR * dx / r5 - this.inducedPx / r3);
            ey += (3 * pDotR * dy / r5 - this.inducedPy / r3);
        }

        return { ex, ey };
    }

    getPotentialAt(x, y) {
        let V = 0;
        if (this.q !== 0) {
            const d = dist(x, y, this.x, this.y);
            if (d >= this.radius) V += K * this.q / d;
        }
        // 偶极子电势: V = p·r̂ / (4πε₀ r²)
        const dx = x - this.x;
        const dy = y - this.y;
        const r2 = dx * dx + dy * dy;
        if (r2 >= this.radius * this.radius) {
            const r = Math.sqrt(r2);
            V += (this.inducedPx * dx + this.inducedPy * dy) / r2;
        }
        return V;
    }

    draw(ctx) {
        // 光晕
        const glowGrad = ctx.createRadialGradient(
            this.x, this.y, this.radius * 0.7,
            this.x, this.y, this.radius + 5);
        glowGrad.addColorStop(0, "rgba(180,180,200,0.1)");
        glowGrad.addColorStop(1, "rgba(180,180,200,0)");
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius + 5, 0, Math.PI * 2);
        ctx.fillStyle = glowGrad;
        ctx.fill();

        // 主体 - 金属质感
        const bodyGrad = ctx.createRadialGradient(
            this.x - this.radius * 0.3, this.y - this.radius * 0.3, this.radius * 0.05,
            this.x, this.y, this.radius);
        bodyGrad.addColorStop(0, "#e8e8f0");
        bodyGrad.addColorStop(0.4, "#b0b0c0");
        bodyGrad.addColorStop(0.8, "#606070");
        bodyGrad.addColorStop(1, "#404050");
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = bodyGrad;
        ctx.fill();
        ctx.strokeStyle = "rgba(200,200,220,0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // 感应电荷可视化（表面颜色表示极化）
        if (Math.abs(this.inducedPx) > 0.1 || Math.abs(this.inducedPy) > 0.1) {
            const pmag = Math.sqrt(this.inducedPx ** 2 + this.inducedPy ** 2);
            if (pmag > 0.01) {
                const pnx = this.inducedPx / pmag;
                const pny = this.inducedPy / pmag;
                // 正感应电荷侧（红色弧）
                ctx.beginPath();
                const ang = Math.atan2(pny, pnx);
                ctx.arc(this.x, this.y, this.radius + 2, ang - Math.PI / 3, ang + Math.PI / 3);
                ctx.strokeStyle = "rgba(255,80,60,0.6)";
                ctx.lineWidth = 2;
                ctx.stroke();
                // 负感应电荷侧（蓝色弧）
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius + 2, ang + Math.PI * 2 / 3, ang + Math.PI * 4 / 3);
                ctx.strokeStyle = "rgba(60,120,255,0.6)";
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }

        // 净电荷标记
        if (this.q !== 0) {
            ctx.fillStyle = "white";
            ctx.font = 'bold 10px "Microsoft YaHei", sans-serif';
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(`Q=${this.q.toFixed(1)}`, this.x, this.y);
        }

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius + 6, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    containsPoint(px, py) {
        return dist2(px, py, this.x, this.y) <= (this.radius + 6) ** 2;
    }
}

// ---- 绝缘块 ----
class InsulatorBlock {
    constructor(x, y, w, h) {
        this.id = nextId();
        this.type = "insulator";
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.q = 0;          // 通过摩擦获得的电荷
        this.fixed = true;
        this.dragging = false;
    }

    draw(ctx) {
        ctx.fillStyle = "rgba(180,160,120,0.7)";
        ctx.fillRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
        ctx.strokeStyle = "rgba(200,180,150,0.5)";
        ctx.lineWidth = 1;
        ctx.strokeRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);

        // 纹理线
        ctx.strokeStyle = "rgba(160,140,100,0.3)";
        ctx.lineWidth = 0.5;
        for (let i = -this.w / 2 + 8; i < this.w / 2; i += 10) {
            ctx.beginPath();
            ctx.moveTo(this.x + i, this.y - this.h / 2 + 3);
            ctx.lineTo(this.x + i, this.y + this.h / 2 - 3);
            ctx.stroke();
        }

        // 电荷标记
        if (this.q !== 0) {
            ctx.fillStyle = "white";
            ctx.font = 'bold 10px "Microsoft YaHei", sans-serif';
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(`Q=${this.q.toFixed(1)}`, this.x, this.y);
        }

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.strokeRect(this.x - this.w / 2 - 3, this.y - this.h / 2 - 3, this.w + 6, this.h + 6);
        }
    }

    containsPoint(px, py) {
        return px >= this.x - this.w / 2 - 3 && px <= this.x + this.w / 2 + 3 &&
            py >= this.y - this.h / 2 - 3 && py <= this.y + this.h / 2 + 3;
    }
}

// ---- 探针 ----
class Probe {
    constructor(x, y, probeType) {
        this.id = nextId();
        this.type = "probe";
        this.probeType = probeType; // "E"、"V" 或 "B"
        this.x = x;
        this.y = y;
        this.dragging = false;
        this.measuredEx = 0;
        this.measuredEy = 0;
        this.measuredV = 0;
        this.measuredBx = 0;
        this.measuredBy = 0;
        this.measuredBz = 0;
    }

    measure() {
        if (this.probeType === "E") {
            const E = computeElectricField(this.x, this.y);
            this.measuredEx = E.ex;
            this.measuredEy = E.ey;
        } else if (this.probeType === "V") {
            this.measuredV = computePotential(this.x, this.y);
        } else if (this.probeType === "B") {
            const B = computeMagneticField(this.x, this.y);
            this.measuredBx = B.bx;
            this.measuredBy = B.by;
            this.measuredBz = B.bz;
        }
    }

    draw(ctx) {
        // 十字准星
        const size = 8;
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.x - size, this.y);
        ctx.lineTo(this.x + size, this.y);
        ctx.moveTo(this.x, this.y - size);
        ctx.lineTo(this.x, this.y + size);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(this.x, this.y, 4, 0, Math.PI * 2);
        ctx.stroke();

        if (this.probeType === "E") {
            // 画电场方向箭头
            const mag = Math.sqrt(this.measuredEx ** 2 + this.measuredEy ** 2);
            if (mag > 0.1) {
                const nx = this.measuredEx / mag;
                const ny = this.measuredEy / mag;
                const arrowLen = Math.min(mag * 0.2, 50);

                ctx.strokeStyle = "#ffcc00";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(this.x, this.y);
                ctx.lineTo(this.x + nx * arrowLen, this.y + ny * arrowLen);
                ctx.stroke();

                // 箭头尖
                const tipSize = 8;
                ctx.beginPath();
                ctx.moveTo(this.x + nx * arrowLen, this.y + ny * arrowLen);
                ctx.lineTo(
                    this.x + nx * (arrowLen - tipSize) - ny * tipSize * 0.5,
                    this.y + ny * (arrowLen - tipSize) + nx * tipSize * 0.5
                );
                ctx.lineTo(
                    this.x + nx * (arrowLen - tipSize) + ny * tipSize * 0.5,
                    this.y + ny * (arrowLen - tipSize) - nx * tipSize * 0.5
                );
                ctx.closePath();
                ctx.fillStyle = "#ffcc00";
                ctx.fill();

                // 数值
                ctx.fillStyle = "#ffcc00";
                ctx.font = '11px "Microsoft YaHei", sans-serif';
                ctx.textAlign = "left";
                ctx.textBaseline = "bottom";
                ctx.fillText(`E=${mag.toFixed(1)}`, this.x + 12, this.y - 12);
            }
        } else if (this.probeType === "V") {
            // 电势探针
            ctx.fillStyle = "#00ff88";
            ctx.font = 'bold 11px "Microsoft YaHei", sans-serif';
            ctx.textAlign = "left";
            ctx.textBaseline = "bottom";
            ctx.fillText(`V=${this.measuredV.toFixed(1)}`, this.x + 12, this.y - 8);
        } else if (this.probeType === "B") {
            // 磁场探针
            const Bmag = Math.sqrt(this.measuredBx ** 2 + this.measuredBy ** 2 + this.measuredBz ** 2);
            if (Bmag > 0.05) {
                // 画面内分量箭头
                const inPlaneMag = Math.sqrt(this.measuredBx ** 2 + this.measuredBy ** 2);
                if (inPlaneMag > 0.05) {
                    const nx = this.measuredBx / inPlaneMag;
                    const ny = this.measuredBy / inPlaneMag;
                    const arrowLen = Math.min(inPlaneMag * 0.3, 50);

                    ctx.strokeStyle = "#00ccff";
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(this.x, this.y);
                    ctx.lineTo(this.x + nx * arrowLen, this.y + ny * arrowLen);
                    ctx.stroke();

                    // 箭头尖
                    const tipSize = 8;
                    ctx.beginPath();
                    ctx.moveTo(this.x + nx * arrowLen, this.y + ny * arrowLen);
                    ctx.lineTo(
                        this.x + nx * (arrowLen - tipSize) - ny * tipSize * 0.5,
                        this.y + ny * (arrowLen - tipSize) + nx * tipSize * 0.5
                    );
                    ctx.lineTo(
                        this.x + nx * (arrowLen - tipSize) + ny * tipSize * 0.5,
                        this.y + ny * (arrowLen - tipSize) - nx * tipSize * 0.5
                    );
                    ctx.closePath();
                    ctx.fillStyle = "#00ccff";
                    ctx.fill();
                }

                // Bz符号标记
                if (Math.abs(this.measuredBz) > 0.1) {
                    ctx.fillStyle = this.measuredBz > 0 ? "#ff8888" : "#8888ff";
                    ctx.font = 'bold 14px "Microsoft YaHei", sans-serif';
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    const bzSymbol = this.measuredBz > 0 ? "⊙" : "⊗";
                    ctx.fillText(bzSymbol, this.x + 16, this.y + 14);
                }

                // 数值
                ctx.fillStyle = "#00ccff";
                ctx.font = '11px "Microsoft YaHei", sans-serif';
                ctx.textAlign = "left";
                ctx.textBaseline = "bottom";
                ctx.fillText(`|B|=${Bmag.toFixed(1)} Bz=${this.measuredBz.toFixed(2)}`,
                    this.x + 12, this.y - 12);
            }
        }

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(this.x, this.y, 12, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    containsPoint(px, py) {
        return dist2(px, py, this.x, this.y) <= 144; // 12^2
    }
}

// ==================== 磁场元件类 ====================

// ---- 条形永磁铁 ----
class BarMagnet {
    constructor(x, y, strength = 3, angle = 0) {
        this.id = nextId();
        this.type = "barMagnet";
        this.x = x;
        this.y = y;
        this.strength = strength;  // 磁偶极矩大小
        this.angle = angle;        // 磁矩方向（弧度），0=水平向右
        this.length = 50;
        this.width = 14;
        this.fixed = true;
        this.dragging = false;

        // 磁偶极矩矢量
        this.mx = Math.cos(angle) * strength;
        this.my = Math.sin(angle) * strength;
    }

    updateMoment() {
        this.mx = Math.cos(this.angle) * this.strength;
        this.my = Math.sin(this.angle) * this.strength;
    }

    /**
     * 磁偶极子场：B = (μ₀/4π) * (3(m·r̂)r̂ - m) / r³
     * 返回 {bx, by, bz}
     */
    getFieldAt(px, py) {
        const dx = px - this.x;
        const dy = py - this.y;
        const r2 = dx * dx + dy * dy;
        const minR2 = (this.length / 2) ** 2;
        const effR2 = Math.max(r2, minR2);
        const r = Math.sqrt(effR2);
        const r3 = effR2 * r;
        const r5 = r3 * effR2;

        const mDotR = this.mx * dx + this.my * dy;

        // 3D偶极子公式（在z=0平面，m在xy平面）
        // Bx = (μ₀/4π) * [3(m·r)x/r⁵ - mx/r³]
        // By = (μ₀/4π) * [3(m·r)y/r⁵ - my/r³]
        // Bz = (μ₀/4π) * [3(m·r)*0/r⁵ - 0/r³] = 0 for m in xy plane, point in xy plane
        // 实际上对于m=(mx,my,0), r=(dx,dy,0), Bz永远为0
        // 但我们需要Bz来产生面内洛伦兹力。
        // 物理上，如果磁矩有z分量，Bz才不为0。
        // 对于2D模拟，人为给磁铁一个小的z分量偏置：
        const mzBias = this.strength * 0.3; // 人为Bz偏置
        const bz = MU0 * (3 * mDotR * 0 / r5 - 0 / r3 + mzBias / r3);

        // 但这样Bz只是1/r³衰减，不是正确的偶极子Bz
        // 正确做法：考虑偶极子有z分量，或考虑点不在z=0平面
        // 简化：在磁铁所在位置附加一个Bz，使得带电粒子能在平面内偏转

        // 更物理的做法：磁偶极子如果完全在xy平面，在xy平面的Bz确实为0
        // 我们让磁铁产生一个等效的Bz场（正比于离磁铁的距离和方向）
        // 对于在磁铁上方/下方的点，Bz ≠ 0
        // 模拟：Bz = μ₀ * m_perp / r³ 其中m_perp是离磁铁轴的垂直分量的某种度量

        // 实际实现：磁铁产生以磁铁为中心的Bz环
        // 简化公式：Bz ∝ (mx*dy - my*dx) / r⁴  (这类似于环形电流的场)
        const bzReal = MU0 * (this.mx * dy - this.my * dx) / (r3 * r);

        return {
            bx: MU0 * (3 * mDotR * dx / r5 - this.mx / r3),
            by: MU0 * (3 * mDotR * dy / r5 - this.my / r3),
            bz: bzReal
        };
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // 主体矩形
        const hw = this.length / 2;
        const hh = this.width / 2;

        // N极（红色）
        const gradN = ctx.createLinearGradient(hw, 0, 0, 0);
        gradN.addColorStop(0, "#ff3333");
        gradN.addColorStop(1, "#cc6666");
        ctx.fillStyle = gradN;
        ctx.fillRect(0, -hh, hw, this.width);

        // S极（蓝色）
        const gradS = ctx.createLinearGradient(-hw, 0, 0, 0);
        gradS.addColorStop(0, "#3366ff");
        gradS.addColorStop(1, "#6688cc");
        ctx.fillStyle = gradS;
        ctx.fillRect(-hw, -hh, hw, this.width);

        // 边框
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-hw, -hh, this.length, this.width);

        // N/S 标记
        ctx.fillStyle = "white";
        ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("N", hw - 12, 0);
        ctx.fillText("S", -hw + 12, 0);

        ctx.restore();

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.rotate(this.angle);
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 3]);
            ctx.strokeRect(-this.length / 2 - 5, -this.width / 2 - 5,
                this.length + 10, this.width + 10);
            ctx.setLineDash([]);
            ctx.restore();
        }
    }

    containsPoint(px, py) {
        const cos = Math.cos(-this.angle);
        const sin = Math.sin(-this.angle);
        const dx = px - this.x;
        const dy = py - this.y;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        return Math.abs(lx) <= this.length / 2 + 6 &&
            Math.abs(ly) <= this.width / 2 + 6;
    }
}

// ---- 电磁铁 ----
class Electromagnet {
    constructor(x, y, current = 3, turns = 5, angle = 0) {
        this.id = nextId();
        this.type = "electromagnet";
        this.x = x;
        this.y = y;
        this.current = current;   // 电流（可正可负）
        this.turns = turns;       // 匝数
        this.angle = angle;
        this.active = true;       // 可开关
        this.length = 40;
        this.width = 20;
        this.fixed = true;
        this.dragging = false;
    }

    getDipoleMoment() {
        // 简化：磁矩 = 匝数 × 电流 × 面积
        return this.turns * this.current * (this.length * this.width) * 0.01;
    }

    getFieldAt(px, py) {
        if (!this.active) return { bx: 0, by: 0, bz: 0 };
        const m = this.getDipoleMoment();
        const mx = Math.cos(this.angle) * m;
        const my = Math.sin(this.angle) * m;

        const dx = px - this.x;
        const dy = py - this.y;
        const r2 = dx * dx + dy * dy;
        const minR2 = (this.length / 2) ** 2;
        const effR2 = Math.max(r2, minR2);
        const r = Math.sqrt(effR2);
        const r3 = effR2 * r;
        const r5 = r3 * effR2;
        const mDotR = mx * dx + my * dy;

        // Bz：类似环形电流
        const bzReal = MU0 * (mx * dy - my * dx) / (r3 * r);

        return {
            bx: MU0 * (3 * mDotR * dx / r5 - mx / r3),
            by: MU0 * (3 * mDotR * dy / r5 - my / r3),
            bz: bzReal
        };
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        const hw = this.length / 2;
        const hh = this.width / 2;

        // 线圈主体
        const activeColor = this.active ?
            (this.current >= 0 ? "#44aa44" : "#aa4444") : "#555555";
        ctx.fillStyle = activeColor;
        ctx.fillRect(-hw, -hh, this.length, this.width);

        // 线圈绕组线
        ctx.strokeStyle = this.active ? "#ffcc00" : "#777777";
        ctx.lineWidth = 1;
        const nCoils = Math.min(this.turns, 8);
        for (let i = 0; i < nCoils; i++) {
            const xPos = -hw + 6 + i * (this.length - 12) / Math.max(nCoils - 1, 1);
            ctx.beginPath();
            ctx.moveTo(xPos, -hh);
            ctx.lineTo(xPos, hh);
            ctx.stroke();
        }

        // 边框
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 1;
        ctx.strokeRect(-hw, -hh, this.length, this.width);

        // 开关指示
        ctx.fillStyle = this.active ? "#00ff00" : "#ff0000";
        ctx.beginPath();
        ctx.arc(hw - 6, -hh + 6, 3, 0, Math.PI * 2);
        ctx.fill();

        // 标记
        ctx.fillStyle = "white";
        ctx.font = '9px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`I=${this.current.toFixed(0)}`, 0, 0);

        ctx.restore();

        if (selectedObject === this || hoveredObject === this) {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.rotate(this.angle);
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 3]);
            ctx.strokeRect(-hw - 4, -hh - 4, this.length + 8, this.width + 8);
            ctx.setLineDash([]);
            ctx.restore();
        }
    }

    containsPoint(px, py) {
        const cos = Math.cos(-this.angle);
        const sin = Math.sin(-this.angle);
        const dx = px - this.x;
        const dy = py - this.y;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        return Math.abs(lx) <= this.length / 2 + 6 &&
            Math.abs(ly) <= this.width / 2 + 6;
    }
}

// ---- 亥姆霍兹线圈对 ----
class HelmholtzCoil {
    constructor(x, y, current = 3, radius = 40) {
        this.id = nextId();
        this.type = "helmholtz";
        this.x = x;           // 中心位置
        this.y = y;
        this.current = current;
        this.radius = radius;  // 线圈半径
        this.separation = radius; // 两线圈间距 = 半径（标准亥姆霍兹配置）
        this.fixed = true;
        this.dragging = false;
    }

    getFieldAt(px, py) {
        // 两线圈中心分别在 (x - R/2, y) 和 (x + R/2, y)
        const cx1 = this.x - this.separation / 2;
        const cx2 = this.x + this.separation / 2;

        const m = this.current * this.radius * this.radius * 0.05;
        // 线圈1（左侧）
        const dx1 = px - cx1;
        const dy1 = py - this.y;
        const r21 = dx1 * dx1 + dy1 * dy1;
        const minR2 = (this.radius / 2) ** 2;
        const r1 = Math.sqrt(Math.max(r21, minR2));
        const r31 = Math.max(r21, minR2) * r1;

        // 线圈2（右侧）
        const dx2 = px - cx2;
        const dy2 = py - this.y;
        const r22 = dx2 * dx2 + dy2 * dy2;
        const r2 = Math.sqrt(Math.max(r22, minR2));
        const r32 = Math.max(r22, minR2) * r2;

        // 线圈产生Bz（环形电流在平面内产生垂直场）
        // 简化：每个线圈产生Bz ∝ 1/r³（类似偶极子但方向为z）
        const bz1 = MU0 * m / r31;
        const bz2 = MU0 * m / r32;
        const bz = bz1 + bz2;

        // 同时计算面内分量（线圈在x方向产生场）
        const r51 = r31 * r21;
        const r52 = r32 * r22;
        const bx1 = MU0 * (3 * m * dx1 * dx1 / r51 - m / r31);
        const bx2 = MU0 * (3 * m * dx2 * dx2 / r52 - m / r32);

        return {
            bx: bx1 + bx2,
            by: 0,
            bz: bz
        };
    }

    draw(ctx) {
        // 左线圈
        const cx1 = this.x - this.separation / 2;
        this.drawCoil(ctx, cx1, this.y, this.radius, this.current);
        // 右线圈
        const cx2 = this.x + this.separation / 2;
        this.drawCoil(ctx, cx2, this.y, this.radius, this.current);

        // 均匀场区域指示
        ctx.fillStyle = "rgba(100,200,255,0.06)";
        ctx.fillRect(this.x - this.radius * 0.6, this.y - this.radius * 0.5,
            this.separation * 1.2, this.radius);

        ctx.fillStyle = "rgba(100,200,255,0.3)";
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText("均匀B场区", this.x, this.y - this.radius * 0.6);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.arc(cx1, this.y, this.radius + 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx2, this.y, this.radius + 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    drawCoil(ctx, cx, cy, r, current) {
        // 线圈圆环
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = current >= 0 ? "#44aacc" : "#cc4444";
        ctx.lineWidth = 3;
        ctx.stroke();

        // 内环
        ctx.beginPath();
        ctx.arc(cx, cy, r - 3, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // 电流方向箭头
        const arrowAngle = current >= 0 ? 0.3 : -0.3;
        const ax = cx + r * Math.cos(arrowAngle);
        const ay = cy + r * Math.sin(arrowAngle);
        ctx.fillStyle = "#ffcc00";
        ctx.beginPath();
        ctx.arc(ax, ay, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    containsPoint(px, py) {
        const cx1 = this.x - this.separation / 2;
        const cx2 = this.x + this.separation / 2;
        return dist2(px, py, cx1, this.y) <= (this.radius + 6) ** 2 ||
            dist2(px, py, cx2, this.y) <= (this.radius + 6) ** 2 ||
            (px >= this.x - this.radius * 0.6 - 4 &&
                px <= this.x + this.radius * 0.6 + this.separation * 0.6 + 4 &&
                py >= this.y - this.radius * 0.5 - 4 &&
                py <= this.y + this.radius * 0.5 + 4);
    }
}

// ---- 铁芯/磁轭 ----
class IronCore {
    constructor(x, y, w = 30, h = 60) {
        this.id = nextId();
        this.type = "ironCore";
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.permeability = 5; // 相对磁导率
        this.magnetized = false; // 是否已被磁化
        this.fixed = true;
        this.dragging = false;
    }

    /**
     * 铁芯修改附近磁场：在铁芯内部增强磁场
     */
    getFieldModification(px, py, bx, by, bz) {
        const dx = px - this.x;
        const dy = py - this.y;
        const inCore = Math.abs(dx) <= this.w / 2 && Math.abs(dy) <= this.h / 2;
        const nearCore = Math.abs(dx) <= this.w && Math.abs(dy) <= this.h;

        if (inCore) {
            return {
                bx: bx * this.permeability,
                by: by * this.permeability,
                bz: bz * this.permeability
            };
        } else if (nearCore) {
            const fx = 1 - Math.abs(dx) / this.w;
            const fy = 1 - Math.abs(dy) / this.h;
            const factor = 1 + (this.permeability - 1) * Math.max(0, Math.min(fx, fy)) * 0.5;
            return { bx: bx * factor, by: by * factor, bz: bz * factor };
        }

        return { bx, by, bz };
    }

    draw(ctx) {
        // 主体 - 铁灰色
        const grad = ctx.createLinearGradient(
            this.x - this.w / 2, this.y,
            this.x + this.w / 2, this.y
        );
        grad.addColorStop(0, "#6a6a7a");
        grad.addColorStop(0.5, "#9a9aaa");
        grad.addColorStop(1, "#5a5a6a");
        ctx.fillStyle = grad;
        ctx.fillRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);

        ctx.strokeStyle = "rgba(200,200,210,0.5)";
        ctx.lineWidth = 1;
        ctx.strokeRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);

        // 层压纹理
        ctx.strokeStyle = "rgba(0,0,0,0.2)";
        ctx.lineWidth = 0.5;
        for (let ly = this.y - this.h / 2 + 6; ly < this.y + this.h / 2; ly += 8) {
            ctx.beginPath();
            ctx.moveTo(this.x - this.w / 2 + 3, ly);
            ctx.lineTo(this.x + this.w / 2 - 3, ly);
            ctx.stroke();
        }

        // 磁化标记
        if (this.magnetized) {
            ctx.fillStyle = "rgba(255,100,100,0.5)";
            ctx.font = 'bold 10px "Microsoft YaHei", sans-serif';
            ctx.textAlign = "center";
            ctx.fillText("M", this.x, this.y);
        }

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 3]);
            ctx.strokeRect(this.x - this.w / 2 - 4, this.y - this.h / 2 - 4,
                this.w + 8, this.h + 8);
            ctx.setLineDash([]);
        }
    }

    containsPoint(px, py) {
        return px >= this.x - this.w / 2 - 5 && px <= this.x + this.w / 2 + 5 &&
            py >= this.y - this.h / 2 - 5 && py <= this.y + this.h / 2 + 5;
    }
}

// ---- 均匀磁场区域（方形/圆形） ----
class UniformBFieldRegion {
    constructor(x, y, shape, size1, size2, bz = 1) {
        this.id = nextId();
        this.type = "uniformBField";
        this.x = x;
        this.y = y;
        this.shape = shape;     // "rect" 或 "circle"
        this.w = size1;         // 方形宽度 / 圆形不用
        this.h = size2;         // 方形高度 / 圆形不用
        this.radius = size1;    // 圆形半径
        this.bz = bz;           // 面外B场强度（正=出页面）
        this.bx = 0;            // 面内B场分量（可选）
        this.by = 0;
        this.edgeWidth = 25;    // 边缘过渡宽度
        this.fixed = true;
        this.dragging = false;
    }

    /**
     * 计算该区域在某点的场贡献
     * 区域内均匀，边缘平滑过渡到零
     */
    getFieldAt(px, py) {
        const dx = px - this.x;
        const dy = py - this.y;

        let factor;
        if (this.shape === "rect") {
            // 方形区域：用smoothstep做边缘过渡
            const hw = this.w / 2;
            const hh = this.h / 2;
            const ew = this.edgeWidth;

            const fx = smoothstep(hw + ew, hw, Math.abs(dx));
            const fy = smoothstep(hh + ew, hh, Math.abs(dy));
            factor = fx * fy;
        } else {
            // 圆形区域：径向smoothstep
            const dist = Math.sqrt(dx * dx + dy * dy);
            factor = smoothstep(this.radius + this.edgeWidth, this.radius, dist);
        }

        return {
            bx: this.bx * factor,
            by: this.by * factor,
            bz: this.bz * factor
        };
    }

    draw(ctx) {
        ctx.save();

        if (this.shape === "rect") {
            // 主体填充
            ctx.fillStyle = this.bz >= 0 ?
                "rgba(255, 100, 80, 0.12)" : "rgba(80, 100, 255, 0.12)";
            ctx.fillRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);

            // 边框
            ctx.strokeStyle = this.bz >= 0 ?
                "rgba(255, 130, 110, 0.55)" : "rgba(110, 130, 255, 0.55)";
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
            ctx.setLineDash([]);

            // 边缘过渡区
            const ew = this.edgeWidth;
            ctx.strokeStyle = this.bz >= 0 ?
                "rgba(255, 130, 110, 0.2)" : "rgba(110, 130, 255, 0.2)";
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 6]);
            ctx.strokeRect(
                this.x - this.w / 2 - ew, this.y - this.h / 2 - ew,
                this.w + ew * 2, this.h + ew * 2
            );
            ctx.setLineDash([]);
        } else {
            // 主体填充
            ctx.fillStyle = this.bz >= 0 ?
                "rgba(255, 100, 80, 0.12)" : "rgba(80, 100, 255, 0.12)";
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fill();

            // 边框
            ctx.strokeStyle = this.bz >= 0 ?
                "rgba(255, 130, 110, 0.55)" : "rgba(110, 130, 255, 0.55)";
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // 边缘过渡区
            ctx.strokeStyle = this.bz >= 0 ?
                "rgba(255, 130, 110, 0.2)" : "rgba(110, 130, 255, 0.2)";
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 6]);
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius + this.edgeWidth, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Bz方向和强度标记
        const bzSymbol = this.bz >= 0 ? "⊙" : "⊗";
        const symbolColor = this.bz >= 0 ? "#ff8888" : "#8888ff";
        ctx.fillStyle = symbolColor;
        ctx.font = 'bold 18px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(bzSymbol, this.x, this.y - 2);

        // 数值
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font = '11px "Microsoft YaHei", sans-serif';
        ctx.fillText(`Bz=${this.bz.toFixed(1)}`, this.x, this.y + 16);

        ctx.restore();

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            if (this.shape === "rect") {
                ctx.strokeRect(this.x - this.w / 2 - 4, this.y - this.h / 2 - 4,
                    this.w + 8, this.h + 8);
            } else {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius + 4, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }

    containsPoint(px, py) {
        if (this.shape === "rect") {
            const ew = this.edgeWidth;
            return px >= this.x - this.w / 2 - ew && px <= this.x + this.w / 2 + ew &&
                py >= this.y - this.h / 2 - ew && py <= this.y + this.h / 2 + ew;
        } else {
            return dist2(px, py, this.x, this.y) <=
                (this.radius + this.edgeWidth + 4) ** 2;
        }
    }
}

// ==================== 阶段三：时变场元件类 ====================

// ---- 波形配置（可附加到任意时变场源） ----
class WaveformConfig {
    constructor(shape = "sine", frequency = 1, phase = 0, amplitude = 1, duty = 0.5) {
        this.shape = shape;       // "sine"|"square"|"triangle"|"sawtooth"|"pulse"
        this.frequency = frequency;
        this.phase = phase;
        this.amplitude = amplitude;
        this.duty = duty;
    }

    getValue(t) {
        return this.amplitude * waveform(this.shape, this.frequency, this.phase, t, this.duty);
    }

    // 获取导数因子（用于计算 d/dt 的近似比例）
    getDerivFactor() {
        return this.amplitude * 2 * Math.PI * this.frequency;
    }
}

// ---- 交变电偶极子 ----
class OscillatingElectricDipole {
    constructor(x, y, chargeAmplitude = 1, separation = 30, angle = 0, wfConfig = null) {
        this.id = nextId();
        this.type = "oscEDipole";
        this.x = x;
        this.y = y;
        this.chargeAmplitude = chargeAmplitude;
        this.separation = separation;  // 正负电荷间距
        this.angle = angle;            // 偶极子轴方向
        this.wfConfig = wfConfig || new WaveformConfig("sine", 0.5, 0, 1);
        this.fixed = true;
        this.dragging = false;
        this.radius = 12;
    }

    getQ(t) {
        return this.wfConfig.getValue(t) * this.chargeAmplitude;
    }

    getPolarizationVector(t) {
        const q = this.getQ(t);
        const px = Math.cos(this.angle) * this.separation;
        const py = Math.sin(this.angle) * this.separation;
        return { px: q * px, py: q * py };
    }

    getFieldAt(px, py) {
        const t = simTime;
        const q = this.getQ(t);
        if (Math.abs(q) < 1e-6) return { ex: 0, ey: 0 };

        const halfSep = this.separation / 2;
        const cos = Math.cos(this.angle);
        const sin = Math.sin(this.angle);

        // 正电荷位置
        const xp = this.x + cos * halfSep;
        const yp = this.y + sin * halfSep;
        // 负电荷位置
        const xn = this.x - cos * halfSep;
        const yn = this.y - sin * halfSep;

        let ex = 0, ey = 0;

        // 正电荷
        const dxp = px - xp, dyp = py - yp;
        const r2p = dxp * dxp + dyp * dyp;
        if (r2p > 1) {
            const rp = Math.sqrt(r2p);
            ex += K * q / r2p * dxp / rp;
            ey += K * q / r2p * dyp / rp;
        }

        // 负电荷
        const dxn = px - xn, dyn = py - yn;
        const r2n = dxn * dxn + dyn * dyn;
        if (r2n > 1) {
            const rn = Math.sqrt(r2n);
            ex += K * (-q) / r2n * dxn / rn;
            ey += K * (-q) / r2n * dyn / rn;
        }

        return { ex, ey };
    }

    /**
     * 位移电流感生磁场：时变电偶极子 → ∂E/∂t → 感生B
     * 简化模型：变化的电偶极矩产生类似环形电流的B场
     * B ≈ (μ₀/4π) * (dp/dt × r̂) / r² 的类比
     */
    getDisplacementBFieldAt(px, py) {
        const dqdt = this.wfConfig.getDerivFactor() * this.chargeAmplitude *
            Math.cos(2 * Math.PI * this.wfConfig.frequency * simTime + this.wfConfig.phase);
        // 对于sine波，d(sin)/dt = ω·cos; 这里简化使用波形因子
        // 准确计算dq/dt
        const dt_small = 0.001;
        const q0 = this.getQ(simTime);
        const q1 = this.getQ(simTime + dt_small);
        const dqdt_accurate = (q1 - q0) / dt_small;

        if (Math.abs(dqdt_accurate) < 1e-8) return { bx: 0, by: 0, bz: 0 };

        const halfSep = this.separation / 2;
        const cos = Math.cos(this.angle);
        const sin = Math.sin(this.angle);
        const dpdt_x = dqdt_accurate * this.separation * cos;
        const dpdt_y = dqdt_accurate * this.separation * sin;

        // 变化的偶极矩产生B场，类似于偶极子辐射近场的磁分量
        // B = (μ₀/4π) * (ṗ × r̂) / (c r²) 的准静态近似
        const dx = px - this.x;
        const dy = py - this.y;
        const r2 = dx * dx + dy * dy;
        const minR2 = this.separation * this.separation;
        const effR2 = Math.max(r2, minR2);
        const r = Math.sqrt(effR2);
        const r3 = effR2 * r;

        // ṗ × r̂ 在2D中：dpdt_x * (dy/r) - dpdt_y * (dx/r) → Bz分量
        const bz = MU0 * 0.05 * (dpdt_x * dy / r - dpdt_y * dx / r) / r3;

        return { bx: 0, by: 0, bz };
    }

    draw(ctx) {
        const t = simTime;
        const q = this.getQ(t);
        const halfSep = this.separation / 2;
        const cos = Math.cos(this.angle);
        const sin = Math.sin(this.angle);

        // 连线
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(this.x - cos * halfSep, this.y - sin * halfSep);
        ctx.lineTo(this.x + cos * halfSep, this.y + sin * halfSep);
        ctx.stroke();
        ctx.setLineDash([]);

        // 正电荷球
        const xp = this.x + cos * halfSep;
        const yp = this.y + sin * halfSep;
        const xn = this.x - cos * halfSep;
        const yn = this.y - sin * halfSep;

        const absQ = Math.abs(q);
        const rPos = this.radius + absQ * 1.5;

        // 正电荷
        const gradP = ctx.createRadialGradient(xp - rPos * 0.3, yp - rPos * 0.3, rPos * 0.05, xp, yp, rPos);
        gradP.addColorStop(0, "#ffaaaa");
        gradP.addColorStop(0.6, q > 0 ? "#dd3333" : "#666666");
        gradP.addColorStop(1, "#881111");
        ctx.beginPath();
        ctx.arc(xp, yp, rPos, 0, Math.PI * 2);
        ctx.fillStyle = gradP;
        ctx.fill();

        // 负电荷
        const rNeg = this.radius + absQ * 1.5;
        const gradN = ctx.createRadialGradient(xn - rNeg * 0.3, yn - rNeg * 0.3, rNeg * 0.05, xn, yn, rNeg);
        gradN.addColorStop(0, "#aabbff");
        gradN.addColorStop(0.6, q < 0 ? "#3355dd" : "#666666");
        gradN.addColorStop(1, "#112288");
        ctx.beginPath();
        ctx.arc(xn, yn, rNeg, 0, Math.PI * 2);
        ctx.fillStyle = gradN;
        ctx.fill();

        // 符号
        ctx.fillStyle = "white";
        ctx.font = `bold ${Math.max(9, this.radius * 0.7)}px "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("+", xp, yp);
        ctx.fillText("−", xn, yn);

        // 振荡指示：中心点按当前q的强度闪烁
        const flashAlpha = 0.15 + Math.abs(q) / this.chargeAmplitude * 0.4;
        ctx.fillStyle = `rgba(255,220,100,${flashAlpha})`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, 6, 0, Math.PI * 2);
        ctx.fill();

        // 波形标记
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font = '9px "Microsoft YaHei", sans-serif';
        ctx.fillText(`f=${this.wfConfig.frequency.toFixed(1)}Hz`, this.x, this.y - this.radius - 14);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.arc(this.x, this.y, halfSep + this.radius + 5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    containsPoint(px, py) {
        const halfSep = this.separation / 2;
        return dist2(px, py, this.x, this.y) <= (halfSep + this.radius + 8) ** 2;
    }
}

// ---- 交变磁偶极子（振荡小磁铁/振荡电流环） ----
class OscillatingMagneticDipole {
    constructor(x, y, momentAmplitude = 3, angle = 0, wfConfig = null) {
        this.id = nextId();
        this.type = "oscMDipole";
        this.x = x;
        this.y = y;
        this.momentAmplitude = momentAmplitude;
        this.angle = angle;        // 磁矩方向
        this.wfConfig = wfConfig || new WaveformConfig("sine", 0.5, 0, 1);
        this.length = 40;
        this.width = 12;
        this.fixed = true;
        this.dragging = false;
    }

    getMoment(t) {
        return this.wfConfig.getValue(t) * this.momentAmplitude;
    }

    getFieldAt(px, py) {
        const t = simTime;
        const m = this.getMoment(t);
        if (Math.abs(m) < 0.001) return { bx: 0, by: 0, bz: 0 };

        const mx = Math.cos(this.angle) * m;
        const my = Math.sin(this.angle) * m;

        const dx = px - this.x;
        const dy = py - this.y;
        const r2 = dx * dx + dy * dy;
        const minR2 = (this.length / 2) ** 2;
        const effR2 = Math.max(r2, minR2);
        const r = Math.sqrt(effR2);
        const r3 = effR2 * r;
        const r5 = r3 * effR2;
        const mDotR = mx * dx + my * dy;

        const bz = MU0 * (mx * dy - my * dx) / (r3 * r);

        return {
            bx: MU0 * (3 * mDotR * dx / r5 - mx / r3),
            by: MU0 * (3 * mDotR * dy / r5 - my / r3),
            bz: bz
        };
    }

    /**
     * 法拉第感应电场：时变磁矩 → dB/dt → 涡旋E场
     * ∮E·dl = -dΦ_B/dt
     * 对点(x,y)，感应电场环绕dB/dt的方向（Lenz定律）
     * E_induced ≈ -(r/2) * (dBz/dt) * φ̂ (对均匀变化近似)
     */
    getInducedEFieldAt(px, py) {
        const t = simTime;
        const dt_small = 0.001;
        const m0 = this.getMoment(t);
        const m1 = this.getMoment(t + dt_small);
        const dmdt = (m1 - m0) / dt_small;

        if (Math.abs(dmdt) < 1e-8) return { ex: 0, ey: 0 };

        const dx = px - this.x;
        const dy = py - this.y;
        const r2 = dx * dx + dy * dy;
        const minR2 = (this.length / 2) ** 2;
        const effR2 = Math.max(r2, minR2);
        const r = Math.sqrt(effR2);

        // 感生电场方向：围绕dB/dt方向（由变化磁矩决定）
        // 在2D中，变化的磁矩产生环形的感生E场
        // E_φ = -(1/(2πr)) * dΦ/dt ≈ -(μ₀/(2π)) * (dm/dt) / r² * (r/2)
        // 简化：|E| ∝ |dm/dt| / r²
        const E_mag = dmdt * MU0 * 0.3 / (effR2);

        // 方向：环绕磁偶极子（r̂ × ẑ 方向，即切线方向）
        const nx = -dy / r;
        const ny = dx / r;

        return {
            ex: E_mag * nx,
            ey: E_mag * ny
        };
    }

    draw(ctx) {
        const t = simTime;
        const m = this.getMoment(t);

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        const hw = this.length / 2;
        const hh = this.width / 2;

        // 振荡亮度
        const intensity = 0.4 + Math.abs(m) / this.momentAmplitude * 0.6;

        // N极
        const gradN = ctx.createLinearGradient(hw, 0, 0, 0);
        gradN.addColorStop(0, `rgba(255,${Math.round(80 - intensity * 30)},${Math.round(80 - intensity * 30)},${intensity})`);
        gradN.addColorStop(1, "rgba(200,120,120,0.6)");
        ctx.fillStyle = gradN;
        ctx.fillRect(0, -hh, hw, this.width);

        // S极
        const gradS = ctx.createLinearGradient(-hw, 0, 0, 0);
        gradS.addColorStop(0, `rgba(${Math.round(80 - intensity * 30)},${Math.round(80 - intensity * 30)},255,${intensity})`);
        gradS.addColorStop(1, "rgba(120,120,200,0.6)");
        ctx.fillStyle = gradS;
        ctx.fillRect(-hw, -hh, hw, this.width);

        // 边框
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-hw, -hh, this.length, this.width);

        // N/S 标记
        ctx.fillStyle = `rgba(255,255,255,${intensity})`;
        ctx.font = 'bold 10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("N", hw - 10, 0);
        ctx.fillText("S", -hw + 10, 0);

        ctx.restore();

        // 振荡指示环
        const ringAlpha = 0.1 + Math.abs(m) / this.momentAmplitude * 0.35;
        ctx.strokeStyle = `rgba(255,200,50,${ringAlpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.length / 2 + 6, 0, Math.PI * 2);
        ctx.setLineDash([2, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // 波形信息
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.font = '9px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText(`f=${this.wfConfig.frequency.toFixed(1)}Hz`, this.x, this.y - this.length / 2 - 8);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(this.x - this.length / 2 - 6, this.y - this.width / 2 - 6,
                this.length + 12, this.width + 12);
            ctx.setLineDash([]);
        }
    }

    containsPoint(px, py) {
        const cos = Math.cos(-this.angle);
        const sin = Math.sin(-this.angle);
        const dx = px - this.x;
        const dy = py - this.y;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        return Math.abs(lx) <= this.length / 2 + 8 &&
            Math.abs(ly) <= this.width / 2 + 8;
    }
}

// ---- 时变匀强E场区域 ----
class TimeVaryingEFieldRegion {
    constructor(x, y, w, h, eAmplitude = 1, eDirection = 0, wfConfig = null) {
        this.id = nextId();
        this.type = "timeVaryingEField";
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.eAmplitude = eAmplitude;
        this.eAngle = eDirection;    // E场方向（弧度，0=水平向右）
        this.wfConfig = wfConfig || new WaveformConfig("sine", 0.5, 0, 1);
        this.edgeWidth = 20;
        this.fixed = true;
        this.dragging = false;
    }

    getEFactor(t) {
        return this.wfConfig.getValue(t);
    }

    getFieldAt(px, py) {
        const t = simTime;
        const factor = this.getEFactor(t);
        if (Math.abs(factor) < 0.001) return { ex: 0, ey: 0 };

        const dx = px - this.x;
        const dy = py - this.y;
        const hw = this.w / 2;
        const hh = this.h / 2;
        const ew = this.edgeWidth;

        const fx = smoothstep(hw + ew, hw, Math.abs(dx));
        const fy = smoothstep(hh + ew, hh, Math.abs(dy));
        const regionFactor = fx * fy;

        const cos = Math.cos(this.eAngle);
        const sin = Math.sin(this.eAngle);

        return {
            ex: factor * this.eAmplitude * cos * regionFactor,
            ey: factor * this.eAmplitude * sin * regionFactor
        };
    }

    /**
     * 位移电流感生B场：时变E场 → ∂E/∂t → 感生B
     * ∇×B = μ₀ε₀ ∂E/∂t
     */
    getDisplacementBFieldAt(px, py) {
        const t = simTime;
        const dt_small = 0.001;
        const f0 = this.getEFactor(t);
        const f1 = this.getEFactor(t + dt_small);
        const dfdt = (f1 - f0) / dt_small;

        if (Math.abs(dfdt) < 1e-8) return { bx: 0, by: 0, bz: 0 };

        const dx = px - this.x;
        const dy = py - this.y;
        const hw = this.w / 2;
        const hh = this.h / 2;
        const ew = this.edgeWidth;

        const fx = smoothstep(hw + ew, hw, Math.abs(dx));
        const fy = smoothstep(hh + ew, hh, Math.abs(dy));
        const regionFactor = fx * fy;
        if (regionFactor < 0.01) return { bx: 0, by: 0, bz: 0 };

        // ∂E/∂t 的方向
        const cos = Math.cos(this.eAngle);
        const sin = Math.sin(this.eAngle);
        const dExdt = dfdt * this.eAmplitude * cos * regionFactor;
        const dEydt = dfdt * this.eAmplitude * sin * regionFactor;

        // 在2D中，面内变化的E产生Bz
        // 类似：Bz ∝ (∂Ey/∂x - ∂Ex/∂y) 但这里是位移电流
        // 简化：|B| ∝ |∂E/∂t| * μ₀ε₀ * r，方向环绕∂E/∂t
        // Bz ≈ μ₀ε₀ * (x*dEy/dt - y*dEx/dt) / 2
        const eps0_mu0_factor = MU0 * EPSILON0 * 0.02;

        // 产生涡旋Bz环绕变化电场区域
        const bz = eps0_mu0_factor * (dx * dEydt - dy * dExdt) * regionFactor;

        return { bx: 0, by: 0, bz };
    }

    draw(ctx) {
        const t = simTime;
        const factor = this.getEFactor(t);
        const absF = Math.abs(factor);

        ctx.save();
        ctx.translate(this.x, this.y);

        // 填充
        const alpha = 0.04 + absF * 0.1;
        ctx.fillStyle = `rgba(255,200,100,${alpha})`;
        ctx.fillRect(-this.w / 2, -this.h / 2, this.w, this.h);

        // 边框
        ctx.strokeStyle = `rgba(255,180,80,${0.3 + absF * 0.5})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]);
        ctx.strokeRect(-this.w / 2, -this.h / 2, this.w, this.h);
        ctx.setLineDash([]);

        // E方向箭头
        const arrowLen = Math.min(this.w, this.h) * 0.3;
        const cos = Math.cos(this.eAngle);
        const sin = Math.sin(this.eAngle);

        ctx.strokeStyle = `rgba(255,200,50,${0.4 + absF * 0.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-cos * arrowLen, -sin * arrowLen);
        ctx.lineTo(cos * arrowLen, sin * arrowLen);
        ctx.stroke();

        // 箭头尖
        const tipX = cos * arrowLen;
        const tipY = sin * arrowLen;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - cos * 10 + sin * 5, tipY - sin * 10 - cos * 5);
        ctx.lineTo(tipX - cos * 10 - sin * 5, tipY - sin * 10 + cos * 5);
        ctx.closePath();
        ctx.fillStyle = `rgba(255,200,50,${0.4 + absF * 0.5})`;
        ctx.fill();

        ctx.restore();

        // 信息
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText(`时变E场 f=${this.wfConfig.frequency.toFixed(1)}Hz`, this.x, this.y - this.h / 2 - 6);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.strokeRect(this.x - this.w / 2 - 4, this.y - this.h / 2 - 4,
                this.w + 8, this.h + 8);
        }
    }

    containsPoint(px, py) {
        return px >= this.x - this.w / 2 - 10 && px <= this.x + this.w / 2 + 10 &&
            py >= this.y - this.h / 2 - 10 && py <= this.y + this.h / 2 + 10;
    }
}

// ---- 时变匀强B场区域 ----
class TimeVaryingBFieldRegion {
    constructor(x, y, w, h, bzAmplitude = 1, wfConfig = null) {
        this.id = nextId();
        this.type = "timeVaryingBField";
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.bzAmplitude = bzAmplitude;
        this.wfConfig = wfConfig || new WaveformConfig("sine", 0.5, 0, 1);
        this.edgeWidth = 20;
        this.fixed = true;
        this.dragging = false;
    }

    getBz(t) {
        return this.wfConfig.getValue(t) * this.bzAmplitude;
    }

    getFieldAt(px, py) {
        const t = simTime;
        const bz = this.getBz(t);
        if (Math.abs(bz) < 0.001) return { bx: 0, by: 0, bz: 0 };

        const dx = px - this.x;
        const dy = py - this.y;
        const hw = this.w / 2;
        const hh = this.h / 2;
        const ew = this.edgeWidth;
        const fx = smoothstep(hw + ew, hw, Math.abs(dx));
        const fy = smoothstep(hh + ew, hh, Math.abs(dy));
        const factor = fx * fy;

        return { bx: 0, by: 0, bz: bz * factor };
    }

    /**
     * 法拉第感应电场：时变Bz → 涡旋E场
     * E环绕dBz/dt方向
     */
    getInducedEFieldAt(px, py) {
        const t = simTime;
        const dt_small = 0.001;
        const bz0 = this.getBz(t);
        const bz1 = this.getBz(t + dt_small);
        const dbzdt = (bz1 - bz0) / dt_small;

        if (Math.abs(dbzdt) < 0.001) return { ex: 0, ey: 0 };

        const dx = px - this.x;
        const dy = py - this.y;
        const hw = this.w / 2;
        const hh = this.h / 2;
        const ew = this.edgeWidth;
        const fx = smoothstep(hw + ew, hw, Math.abs(dx));
        const fy = smoothstep(hh + ew, hh, Math.abs(dy));
        const regionFactor = fx * fy;
        if (regionFactor < 0.01) return { ex: 0, ey: 0 };

        const r2 = dx * dx + dy * dy;
        if (r2 < 1) return { ex: 0, ey: 0 };
        const r = Math.sqrt(r2);

        // 感生电场方向：环绕dBz/dt（切线方向）
        // 如果dBz/dt > 0（Bz增加），根据Lenz定律，感生E场顺时针（在2D中）
        // E = -(r/2) * dBz/dt * φ̂
        const E_mag = -dbzdt * r * 0.5 * regionFactor;

        const nx = -dy / r;
        const ny = dx / r;

        return {
            ex: E_mag * nx,
            ey: E_mag * ny
        };
    }

    draw(ctx) {
        const t = simTime;
        const bz = this.getBz(t);
        const absB = Math.abs(bz);

        ctx.save();

        // 填充
        const alpha = 0.04 + absB * 0.12 / this.bzAmplitude;
        ctx.fillStyle = bz >= 0 ?
            `rgba(255,120,80,${alpha})` : `rgba(80,120,255,${alpha})`;
        ctx.fillRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);

        // 边框
        ctx.strokeStyle = bz >= 0 ?
            `rgba(255,140,110,${0.3 + absB / this.bzAmplitude * 0.5})` :
            `rgba(110,140,255,${0.3 + absB / this.bzAmplitude * 0.5})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
        ctx.setLineDash([]);

        // Bz符号
        const bzSymbol = bz >= 0 ? "⊙" : "⊗";
        const symbolColor = bz >= 0 ? "#ff8888" : "#8888ff";
        ctx.fillStyle = symbolColor;
        ctx.font = 'bold 18px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(bzSymbol, this.x, this.y - 2);

        ctx.restore();

        // 信息
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText(`时变B场 f=${this.wfConfig.frequency.toFixed(1)}Hz`, this.x, this.y - this.h / 2 - 6);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.strokeRect(this.x - this.w / 2 - 4, this.y - this.h / 2 - 4,
                this.w + 8, this.h + 8);
        }
    }

    containsPoint(px, py) {
        return px >= this.x - this.w / 2 - 10 && px <= this.x + this.w / 2 + 10 &&
            py >= this.y - this.h / 2 - 10 && py <= this.y + this.h / 2 + 10;
    }
}

// ---- 涡流环（被动感应体，放置在时变磁场中产生感生电场环） ----
class EddyCurrentRing {
    constructor(x, y, radius = 35) {
        this.id = nextId();
        this.type = "eddyRing";
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.fixed = true;
        this.dragging = false;
        this.inducedEMF = 0;     // 感生电动势
        this.inducedEDir = 0;     // 感生电场方向强度
    }

    /**
     * 计算通过环面的磁通变化率，确定感生电场
     */
    measureInduced() {
        // 采样通过环的Bz通量变化率
        const dt_small = 0.001;
        const t0 = simTime;
        const t1 = t0 + dt_small;

        let flux0 = 0, flux1 = 0;
        const nSamples = 12;
        for (let i = 0; i < nSamples; i++) {
            const ang = (i / nSamples) * 2 * Math.PI;
            const sx = this.x + Math.cos(ang) * this.radius * 0.7;
            const sy = this.y + Math.sin(ang) * this.radius * 0.7;

            const B0 = computeMagneticField(sx, sy);
            flux0 += B0.bz;

            // 数值近似t1时刻（只考虑时变源的变化）
            const B1 = computeMagneticField(sx, sy);
            flux1 += B1.bz;
        }
        flux0 /= nSamples;
        flux1 /= nSamples;

        // 实际dB/dt由时变源决定，这里简化
        this.inducedEMF = -(flux1 - flux0) / dt_small * Math.PI * this.radius * this.radius * 0.5;
        this.inducedEDir = this.inducedEMF / (2 * Math.PI * this.radius);
    }

    getInducedFieldAt(px, py) {
        const dx = px - this.x;
        const dy = py - this.y;
        const r2 = dx * dx + dy * dy;
        const r = Math.sqrt(Math.max(r2, 1));

        // 在环附近产生环形感生电场
        const distFromRing = Math.abs(r - this.radius);
        const ringWidth = 15;
        if (distFromRing > ringWidth) return { ex: 0, ey: 0 };

        const intensity = this.inducedEDir *
            (1 - distFromRing / ringWidth) * 0.3;
        const nx = -dy / r;
        const ny = dx / r;

        return { ex: intensity * nx, ey: intensity * ny };
    }

    draw(ctx) {
        // 环
        const intensity = Math.abs(this.inducedEDir);
        const glowAlpha = 0.15 + Math.min(intensity * 2, 0.5);

        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,255,150,${0.4 + glowAlpha})`;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // 感生电场方向指示（切线箭头）
        if (Math.abs(this.inducedEDir) > 0.01) {
            const nArrows = 6;
            const direction = this.inducedEDir > 0 ? -1 : 1; // Lenz定律方向
            for (let i = 0; i < nArrows; i++) {
                const ang = (i / nArrows) * 2 * Math.PI;
                const ax = this.x + Math.cos(ang) * this.radius;
                const ay = this.y + Math.sin(ang) * this.radius;

                ctx.fillStyle = `rgba(0,255,150,${0.5 + glowAlpha})`;
                ctx.beginPath();
                const tanAng = ang + direction * Math.PI / 2;
                ctx.arc(ax, ay, 3, 0, Math.PI * 2);
                ctx.fill();

                // 小箭头
                ctx.strokeStyle = `rgba(0,255,150,${0.5 + glowAlpha})`;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(ax, ay);
                ctx.lineTo(ax + Math.cos(tanAng) * 8, ay + Math.sin(tanAng) * 8);
                ctx.stroke();
            }
        }

        // 标签
        ctx.fillStyle = "rgba(0,255,150,0.8)";
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText("涡流环", this.x, this.y - this.radius - 8);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius + 6, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    containsPoint(px, py) {
        const d = dist(px, py, this.x, this.y);
        return d >= this.radius - 12 && d <= this.radius + 12;
    }
}

// ---- 极化涡旋盘（被动感应体，放置在时变E场中产生感生B场） ----
class PolarizationVortexDisk {
    constructor(x, y, radius = 30) {
        this.id = nextId();
        this.type = "polarDisk";
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.fixed = true;
        this.dragging = false;
        this.inducedBz = 0;      // 等效位移电流产生的感生Bz
    }

    measureInduced() {
        // 采样盘内E场的变化率
        const dt_small = 0.001;
        let dEdt_x = 0, dEdt_y = 0;
        const nSamples = 8;

        for (let i = 0; i < nSamples; i++) {
            const ang = (i / nSamples) * 2 * Math.PI;
            const sx = this.x + Math.cos(ang) * this.radius * 0.6;
            const sy = this.y + Math.sin(ang) * this.radius * 0.6;

            const E0 = computeElectricField(sx, sy);
            const E1 = computeElectricField(sx, sy);
            dEdt_x += (E1.ex - E0.ex) / nSamples;
            dEdt_y += (E1.ey - E0.ey) / nSamples;
        }

        // 位移电流密度 J_d = ε₀ ∂E/∂t
        // 感生Bz ∝ 位移电流的旋度
        this.inducedBz = EPSILON0 * MU0 * this.radius * 0.08 *
            Math.sqrt(dEdt_x * dEdt_x + dEdt_y * dEdt_y);
    }

    getInducedFieldAt(px, py) {
        const dx = px - this.x;
        const dy = py - this.y;
        const r2 = dx * dx + dy * dy;
        const r = Math.sqrt(Math.max(r2, 1));

        if (r > this.radius * 1.5) return { bx: 0, by: 0, bz: 0 };

        // 盘内产生环形的感生B场
        const diskFactor = r < this.radius ?
            1 - (this.radius - r) / this.radius * 0.3 :
            (this.radius * 1.5 - r) / (this.radius * 0.5);
        const clampedFactor = Math.max(0, Math.min(1, diskFactor));

        // B场方向环绕位移电流
        const bz = this.inducedBz * clampedFactor;
        const bx = -dy / r * this.inducedBz * clampedFactor * 0.3;
        const by = dx / r * this.inducedBz * clampedFactor * 0.3;

        return { bx, by, bz };
    }

    draw(ctx) {
        // 盘体
        const intensity = Math.abs(this.inducedBz);
        const glowAlpha = 0.1 + Math.min(intensity * 0.5, 0.4);

        const grad = ctx.createRadialGradient(this.x, this.y, this.radius * 0.2,
            this.x, this.y, this.radius);
        grad.addColorStop(0, `rgba(200,100,255,${0.15 + glowAlpha})`);
        grad.addColorStop(1, `rgba(200,100,255,0)`);
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.strokeStyle = `rgba(200,120,255,${0.3 + glowAlpha})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Bz指示
        if (Math.abs(this.inducedBz) > 0.01) {
            const bzSymbol = this.inducedBz > 0 ? "⊙" : "⊗";
            ctx.fillStyle = this.inducedBz > 0 ?
                "rgba(255,150,150,0.8)" : "rgba(150,150,255,0.8)";
            ctx.font = 'bold 16px "Microsoft YaHei", sans-serif';
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(bzSymbol, this.x, this.y);
        }

        // 标签
        ctx.fillStyle = "rgba(200,150,255,0.8)";
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText("极化涡旋盘", this.x, this.y - this.radius - 8);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius + 5, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    containsPoint(px, py) {
        return dist2(px, py, this.x, this.y) <= (this.radius + 6) ** 2;
    }
}

// ---- 感生场探针（区分库仑场与感生场分量） ----
class InducedFieldProbe {
    constructor(x, y) {
        this.id = nextId();
        this.type = "inducedProbe";
        this.x = x;
        this.y = y;
        this.dragging = false;
        this.coulombEx = 0;
        this.coulombEy = 0;
        this.inducedEx = 0;
        this.inducedEy = 0;
        this.totalEx = 0;
        this.totalEy = 0;
    }

    measure() {
        // 总场
        const Etotal = computeElectricField(this.x, this.y);

        // 仅计算库仑场（排除时变感应源）
        let cEx = 0, cEy = 0;
        for (const c of charges) {
            const dx = this.x - c.x, dy = this.y - c.y;
            const r2 = dx * dx + dy * dy;
            if (r2 < 1) continue;
            const r = Math.sqrt(r2);
            const E = K * c.q / r2;
            cEx += E * dx / r;
            cEy += E * dy / r;
        }
        for (const p of plates) {
            const c = p.getFieldAt(this.x, this.y);
            cEx += c.ex;
            cEy += c.ey;
        }
        for (const mb of metalBalls) {
            const c = mb.getFieldAt(this.x, this.y);
            cEx += c.ex;
            cEy += c.ey;
        }
        for (const ins of insulators) {
            if (ins.q === 0) continue;
            const dx = this.x - ins.x, dy = this.y - ins.y;
            const r2 = dx * dx + dy * dy;
            if (r2 < 1) continue;
            const r = Math.sqrt(r2);
            const E = K * ins.q / r2;
            cEx += E * dx / r;
            cEy += E * dy / r;
        }
        // 纳入交变电偶极子的库仑场
        for (const oed of oscEDipoles) {
            const c = oed.getFieldAt(this.x, this.y);
            cEx += c.ex;
            cEy += c.ey;
        }
        for (const tve of timeVaryingEFields) {
            const c = tve.getFieldAt(this.x, this.y);
            cEx += c.ex;
            cEy += c.ey;
        }

        this.coulombEx = cEx;
        this.coulombEy = cEy;
        this.totalEx = Etotal.ex;
        this.totalEy = Etotal.ey;
        this.inducedEx = Etotal.ex - cEx;
        this.inducedEy = Etotal.ey - cEy;
    }

    draw(ctx) {
        // 十字准星
        const size = 8;
        ctx.strokeStyle = "rgba(255,180,255,0.8)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.x - size, this.y);
        ctx.lineTo(this.x + size, this.y);
        ctx.moveTo(this.x, this.y - size);
        ctx.lineTo(this.x, this.y + size);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(this.x, this.y, 5, 0, Math.PI * 2);
        ctx.stroke();

        // 库仑场（黄色）
        const cmag = Math.sqrt(this.coulombEx ** 2 + this.coulombEy ** 2);
        if (cmag > 0.05) {
            const cnx = this.coulombEx / cmag;
            const cny = this.coulombEy / cmag;
            const clen = Math.min(cmag * 0.15, 40);
            ctx.strokeStyle = "rgba(255,200,50,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(this.x, this.y);
            ctx.lineTo(this.x + cnx * clen, this.y + cny * clen);
            ctx.stroke();
        }

        // 感生场（品红）
        const imag = Math.sqrt(this.inducedEx ** 2 + this.inducedEy ** 2);
        if (imag > 0.05) {
            const inx = this.inducedEx / imag;
            const iny = this.inducedEy / imag;
            const ilen = Math.min(imag * 0.15, 40);
            ctx.strokeStyle = "rgba(255,50,255,0.9)";
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 2]);
            ctx.beginPath();
            ctx.moveTo(this.x, this.y);
            ctx.lineTo(this.x + inx * ilen, this.y + iny * ilen);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 读数
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`库仑|E|=${cmag.toFixed(1)} 感生|E|=${imag.toFixed(2)}`,
            this.x + 12, this.y - 10);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(this.x, this.y, 13, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    containsPoint(px, py) {
        return dist2(px, py, this.x, this.y) <= 169;
    }
}

// ---- 位移电流密度探针 ∂E/∂t ----
class DisplacementCurrentProbe {
    constructor(x, y) {
        this.id = nextId();
        this.type = "dispCurrentProbe";
        this.x = x;
        this.y = y;
        this.dragging = false;
        this.dEdt_x = 0;
        this.dEdt_y = 0;
        this.dEdt_mag = 0;
    }

    measure() {
        const dt_small = 0.001;
        const E0 = computeElectricField(this.x, this.y);
        const E1 = computeElectricField(this.x, this.y);
        this.dEdt_x = (E1.ex - E0.ex) / dt_small;
        this.dEdt_y = (E1.ey - E0.ey) / dt_small;
        this.dEdt_mag = Math.sqrt(this.dEdt_x ** 2 + this.dEdt_y ** 2);
    }

    draw(ctx) {
        const size = 8;
        ctx.strokeStyle = "rgba(255,200,100,0.7)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.x - size, this.y);
        ctx.lineTo(this.x + size, this.y);
        ctx.moveTo(this.x, this.y - size);
        ctx.lineTo(this.x, this.y + size);
        ctx.stroke();

        if (this.dEdt_mag > 0.01) {
            const nx = this.dEdt_x / this.dEdt_mag;
            const ny = this.dEdt_y / this.dEdt_mag;
            const len = Math.min(this.dEdt_mag * 0.02, 45);
            ctx.strokeStyle = "rgba(255,180,50,0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(this.x, this.y);
            ctx.lineTo(this.x + nx * len, this.y + ny * len);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`∂E/∂t=${this.dEdt_mag.toFixed(2)}`, this.x + 12, this.y - 8);

        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(this.x, this.y, 12, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    containsPoint(px, py) {
        return dist2(px, py, this.x, this.y) <= 144;
    }
}

// ---- 磁通变化率探针 dΦ_B/dt ----
class FluxChangeProbe {
    constructor(x, y, radius = 30) {
        this.id = nextId();
        this.type = "fluxProbe";
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.dragging = false;
        this.dPhidt = 0;
        this.avgBz = 0;
    }

    measure() {
        const dt_small = 0.001;
        let flux0 = 0, flux1 = 0;
        const nSamples = 10;

        for (let i = 0; i < nSamples; i++) {
            const ang = (i / nSamples) * 2 * Math.PI;
            const sx = this.x + Math.cos(ang) * this.radius * 0.7;
            const sy = this.y + Math.sin(ang) * this.radius * 0.7;
            const B0 = computeMagneticField(sx, sy);
            const B1 = computeMagneticField(sx, sy);
            flux0 += B0.bz;
            flux1 += B1.bz;
        }
        flux0 /= nSamples;
        flux1 /= nSamples;
        this.avgBz = flux0;
        this.dPhidt = (flux1 - flux0) / dt_small * Math.PI * this.radius * this.radius;
    }

    draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(100,200,255,0.5)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText(`dΦ/dt=${this.dPhidt.toFixed(2)}`, this.x, this.y - this.radius - 8);

        // 选中高亮
        if (selectedObject === this || hoveredObject === this) {
            ctx.strokeStyle = "rgba(255,255,100,0.8)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius + 5, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    containsPoint(px, py) {
        return dist2(px, py, this.x, this.y) <= this.radius + 6;
    }
}


// smoothstep 辅助函数
function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return 1 - t * t * (3 - 2 * t);
}

// ==================== 可视化绘制 ====================

// 电场线（网格箭头）
function drawFieldLines() {
    if (!showFieldLines) return;

    const step = FIELD_GRID_STEP;
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 0.8;

    for (let x = step / 2; x < canvas.width; x += step) {
        for (let y = step / 2; y < canvas.height; y += step) {
            const E = computeElectricField(x, y);
            const len = Math.sqrt(E.ex ** 2 + E.ey ** 2);
            if (len < 0.05) continue;

            // 归一化并限制最大显示长度
            const scale = Math.min(ARROW_SCALE, len * 2) / len;
            const ex = E.ex * scale;
            const ey = E.ey * scale;

            // 场强映射颜色
            const intensity = Math.min(len / 3.0, 1.0);
            ctx.strokeStyle = `rgba(${Math.round(100 + intensity * 155)}, ${Math.round(180 - intensity * 100)}, ${Math.round(220 - intensity * 160)}, ${0.15 + intensity * 0.2})`;

            ctx.beginPath();
            ctx.moveTo(x - ex * 0.5, y - ey * 0.5);
            ctx.lineTo(x + ex * 0.5, y + ey * 0.5);
            ctx.stroke();

            // 小箭头尖
            const tipSize = 3;
            const ang = Math.atan2(ey, ex);
            ctx.beginPath();
            ctx.moveTo(x + ex * 0.5, y + ey * 0.5);
            ctx.lineTo(
                x + ex * 0.5 - tipSize * Math.cos(ang - 0.8),
                y + ey * 0.5 - tipSize * Math.sin(ang - 0.8)
            );
            ctx.lineTo(
                x + ex * 0.5 - tipSize * Math.cos(ang + 0.8),
                y + ey * 0.5 - tipSize * Math.sin(ang + 0.8)
            );
            ctx.closePath();
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
        }
    }
}

// 磁感线（网格箭头 + Bz颜色图）
function drawBFieldLines() {
    if (!showBFieldLines) return;

    const step = BFIELD_GRID_STEP;

    // 先绘制Bz热力图背景
    const cols = Math.ceil(canvas.width / step);
    const rows = Math.ceil(canvas.height / step);
    const bzValues = new Float32Array(cols * rows);
    let bzMin = Infinity, bzMax = -Infinity;
    let hasMagneticField = false;

    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const x = i * step;
            const y = j * step;
            const B = computeMagneticField(x, y);
            const bmag = Math.abs(B.bx) + Math.abs(B.by) + Math.abs(B.bz);
            if (bmag > 0.01) hasMagneticField = true;
            bzValues[j * cols + i] = B.bz;
            if (B.bz < bzMin) bzMin = B.bz;
            if (B.bz > bzMax) bzMax = B.bz;
        }
    }

    if (!hasMagneticField) return;

    // Bz热力图
    if (bzMax - bzMin > 0.001) {
        const imgData = ctx.createImageData(cols, rows);
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const bz = bzValues[j * cols + i];
                const t = (bz - bzMin) / (bzMax - bzMin + 0.001);
                const idx = (j * cols + i) * 4;
                // 蓝(负Bz/进页面) → 透明 → 红(正Bz/出页面)
                if (Math.abs(bz) < bzMax * 0.02 + 0.001) {
                    imgData.data[idx + 3] = 0; // 接近零，透明
                } else if (bz < 0) {
                    const s = Math.min(Math.abs(bz) / (Math.abs(bzMin) + 0.001), 1);
                    imgData.data[idx] = Math.round(30 + s * 20);
                    imgData.data[idx + 1] = Math.round(40 + s * 30);
                    imgData.data[idx + 2] = Math.round(150 + s * 105);
                    imgData.data[idx + 3] = Math.round(25 + s * 30);
                } else {
                    const s = Math.min(bz / (bzMax + 0.001), 1);
                    imgData.data[idx] = Math.round(150 + s * 105);
                    imgData.data[idx + 1] = Math.round(40 + s * 20);
                    imgData.data[idx + 2] = Math.round(30 + s * 20);
                    imgData.data[idx + 3] = Math.round(25 + s * 30);
                }
            }
        }
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = cols;
        tempCanvas.height = rows;
        const tempCtx = tempCanvas.getContext("2d");
        tempCtx.putImageData(imgData, 0, 0);
        ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
    }

    // 磁感线箭头（显示Bx, By面内分量）
    for (let x = step / 2; x < canvas.width; x += step) {
        for (let y = step / 2; y < canvas.height; y += step) {
            const B = computeMagneticField(x, y);
            const inPlaneLen = Math.sqrt(B.bx ** 2 + B.by ** 2);
            if (inPlaneLen < 0.05) continue;

            const scale = Math.min(BARROW_SCALE, inPlaneLen * 2.5) / inPlaneLen;
            const bx = B.bx * scale;
            const by = B.by * scale;

            const intensity = Math.min(inPlaneLen / 2.0, 1.0);
            ctx.strokeStyle = `rgba(${Math.round(60 + intensity * 100)}, ${Math.round(180 + intensity * 75)}, ${Math.round(220)}, ${0.2 + intensity * 0.25})`;

            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(x - bx * 0.5, y - by * 0.5);
            ctx.lineTo(x + bx * 0.5, y + by * 0.5);
            ctx.stroke();

            // 小箭头尖
            const tipSize = 3;
            const ang = Math.atan2(by, bx);
            ctx.beginPath();
            ctx.moveTo(x + bx * 0.5, y + by * 0.5);
            ctx.lineTo(
                x + bx * 0.5 - tipSize * Math.cos(ang - 0.8),
                y + by * 0.5 - tipSize * Math.sin(ang - 0.8)
            );
            ctx.lineTo(
                x + bx * 0.5 - tipSize * Math.cos(ang + 0.8),
                y + by * 0.5 - tipSize * Math.sin(ang + 0.8)
            );
            ctx.closePath();
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
        }
    }
}

// 等势面（颜色填充）
function drawEquipotential() {
    if (!showEquipotential) return;

    const step = 20; // 计算精度
    const cols = Math.ceil(canvas.width / step);
    const rows = Math.ceil(canvas.height / step);

    // 先采样电势
    const potentials = new Float32Array(cols * rows);
    let vMin = Infinity, vMax = -Infinity;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const x = i * step;
            const y = j * step;
            const V = computePotential(x, y);
            potentials[j * cols + i] = V;
            if (V < vMin) vMin = V;
            if (V > vMax) vMax = V;
        }
    }

    if (vMax - vMin < 1) return;

    // 绘制等势区域
    const imgData = ctx.createImageData(cols, rows);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const V = potentials[j * cols + i];
            const t = (V - vMin) / (vMax - vMin);
            let r, g, b;
            if (t < 0.5) {
                const s = t * 2;
                r = Math.round(30 + s * 40);
                g = Math.round(40 + s * 80);
                b = Math.round(180 - s * 60);
            } else {
                const s = (t - 0.5) * 2;
                r = Math.round(70 + s * 185);
                g = Math.round(120 - s * 80);
                b = Math.round(120 - s * 90);
            }
            const idx = (j * cols + i) * 4;
            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = Math.round(60 + t * 25);
        }
    }

    // 缩放到画布
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = cols;
    tempCanvas.height = rows;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.putImageData(imgData, 0, 0);
    ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
}

// 网格背景
function drawGrid() {
    if (!showGrid) return;
    const step = 60;
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth = 0.5;
    for (let x = step; x < canvas.width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (let y = step; y < canvas.height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
}

// ==================== 对象查找 ====================
function findObjectAt(x, y) {
    // 优先找探针（小目标）
    for (const p of probes) {
        if (p.containsPoint(x, y)) return p;
    }
    for (const ip of inducedProbes) {
        if (ip.containsPoint(x, y)) return ip;
    }
    for (const dp of dispCurrentProbes) {
        if (dp.containsPoint(x, y)) return dp;
    }
    for (const fp of fluxProbes) {
        if (fp.containsPoint(x, y)) return fp;
    }
    for (const c of charges) {
        if (c.containsPoint(x, y)) return c;
    }
    for (const mb of metalBalls) {
        if (mb.containsPoint(x, y)) return mb;
    }
    for (const ins of insulators) {
        if (ins.containsPoint(x, y)) return ins;
    }
    for (const p of plates) {
        if (p.containsPoint(x, y)) return p;
    }
    for (const bm of barMagnets) {
        if (bm.containsPoint(x, y)) return bm;
    }
    for (const em of electromagnets) {
        if (em.containsPoint(x, y)) return em;
    }
    for (const hc of helmholtzCoils) {
        if (hc.containsPoint(x, y)) return hc;
    }
    for (const ic of ironCores) {
        if (ic.containsPoint(x, y)) return ic;
    }
    for (const ubf of uniformBFields) {
        if (ubf.containsPoint(x, y)) return ubf;
    }
    for (const oed of oscEDipoles) {
        if (oed.containsPoint(x, y)) return oed;
    }
    for (const omd of oscMDipoles) {
        if (omd.containsPoint(x, y)) return omd;
    }
    for (const tve of timeVaryingEFields) {
        if (tve.containsPoint(x, y)) return tve;
    }
    for (const tvb of timeVaryingBFields) {
        if (tvb.containsPoint(x, y)) return tvb;
    }
    for (const er of eddyRings) {
        if (er.containsPoint(x, y)) return er;
    }
    for (const pd of polarDisks) {
        if (pd.containsPoint(x, y)) return pd;
    }
    return null;
}

// ==================== 物体管理 ====================
function removeObject(obj) {
    if (!obj) return;
    if (obj.type === "charge") {
        charges = charges.filter(c => c !== obj);
    } else if (obj.type === "plate") {
        plates = plates.filter(p => p !== obj);
    } else if (obj.type === "metalBall") {
        metalBalls = metalBalls.filter(m => m !== obj);
    } else if (obj.type === "insulator") {
        insulators = insulators.filter(i => i !== obj);
    } else if (obj.type === "probe") {
        probes = probes.filter(p => p !== obj);
    } else if (obj.type === "barMagnet") {
        barMagnets = barMagnets.filter(b => b !== obj);
    } else if (obj.type === "electromagnet") {
        electromagnets = electromagnets.filter(e => e !== obj);
    } else if (obj.type === "helmholtz") {
        helmholtzCoils = helmholtzCoils.filter(h => h !== obj);
    } else if (obj.type === "ironCore") {
        ironCores = ironCores.filter(i => i !== obj);
    } else if (obj.type === "uniformBField") {
        uniformBFields = uniformBFields.filter(u => u !== obj);
    } else if (obj.type === "oscEDipole") {
        oscEDipoles = oscEDipoles.filter(o => o !== obj);
    } else if (obj.type === "oscMDipole") {
        oscMDipoles = oscMDipoles.filter(o => o !== obj);
    } else if (obj.type === "timeVaryingEField") {
        timeVaryingEFields = timeVaryingEFields.filter(t => t !== obj);
    } else if (obj.type === "timeVaryingBField") {
        timeVaryingBFields = timeVaryingBFields.filter(t => t !== obj);
    } else if (obj.type === "eddyRing") {
        eddyRings = eddyRings.filter(e => e !== obj);
    } else if (obj.type === "polarDisk") {
        polarDisks = polarDisks.filter(p => p !== obj);
    } else if (obj.type === "inducedProbe") {
        inducedProbes = inducedProbes.filter(i => i !== obj);
    } else if (obj.type === "dispCurrentProbe") {
        dispCurrentProbes = dispCurrentProbes.filter(d => d !== obj);
    } else if (obj.type === "fluxProbe") {
        fluxProbes = fluxProbes.filter(f => f !== obj);
    }
    if (selectedObject === obj) {
        selectObject(null);
    }
}

function clearAll() {
    charges = [];
    plates = [];
    metalBalls = [];
    insulators = [];
    probes = [];
    barMagnets = [];
    electromagnets = [];
    helmholtzCoils = [];
    ironCores = [];
    uniformBFields = [];
    oscEDipoles = [];
    oscMDipoles = [];
    timeVaryingEFields = [];
    timeVaryingBFields = [];
    eddyRings = [];
    polarDisks = [];
    inducedProbes = [];
    dispCurrentProbes = [];
    fluxProbes = [];
    simTime = 0;
    selectObject(null);
}

function selectObject(obj) {
    selectedObject = obj;
    updatePropertyPanel(obj);
}

// ==================== 属性面板 ====================
function updatePropertyPanel(obj) {
    const panel = document.getElementById("propertyPanel");
    if (!obj) {
        panel.classList.add("hidden");
        return;
    }
    panel.classList.remove("hidden");

    // 显示/隐藏各行
    const rowCharge = document.getElementById("rowCharge");
    const rowStrength = document.getElementById("rowStrength");
    const rowCurrent = document.getElementById("rowCurrent");
    const rowFixed = document.getElementById("rowFixed");
    const rowMass = document.getElementById("rowMass");
    const rowAngle = document.getElementById("rowAngle");

    // 默认全部隐藏
    [rowCharge, rowStrength, rowCurrent, rowFixed, rowMass, rowAngle].forEach(r => {
        if (r) r.style.display = "none";
    });

    const typeNames = {
        charge: obj.q > 0 ? "正电荷" : "负电荷",
        plate: "带电平板",
        metalBall: "金属球(导体)",
        insulator: "绝缘块",
        probe: obj.probeType === "E" ? "电场探针" :
            obj.probeType === "V" ? "电势探针" : "磁场探针",
        barMagnet: "条形永磁铁",
        electromagnet: "电磁铁",
        helmholtz: "亥姆霍兹线圈",
        ironCore: "铁芯/磁轭",
        uniformBField: obj.shape === "rect" ? "方形均匀B场" : "圆形均匀B场",
        oscEDipole: "交变电偶极子",
        oscMDipole: "交变磁偶极子",
        timeVaryingEField: "时变匀强E场",
        timeVaryingBField: "时变匀强B场",
        eddyRing: "涡流环",
        polarDisk: "极化涡旋盘",
        inducedProbe: "感生场探针",
        dispCurrentProbe: "位移电流探针",
        fluxProbe: "磁通变化率探针"
    };
    document.getElementById("propType").textContent = typeNames[obj.type] || "-";

    const chargeSlider = document.getElementById("propCharge");
    const chargeVal = document.getElementById("propChargeVal");
    const strengthSlider = document.getElementById("propStrength");
    const strengthVal = document.getElementById("propStrengthVal");
    const currentSlider = document.getElementById("propCurrent");
    const currentVal = document.getElementById("propCurrentVal");
    const fixedCheck = document.getElementById("propFixed");
    const massSlider = document.getElementById("propMass");
    const massVal = document.getElementById("propMassVal");
    const angleSlider = document.getElementById("propAngle");
    const angleVal = document.getElementById("propAngleVal");

    // 根据类型显示对应行
    if (obj.type === "charge") {
        if (rowCharge) rowCharge.style.display = "flex";
        if (rowFixed) rowFixed.style.display = "flex";
        if (rowMass) rowMass.style.display = "flex";
        chargeSlider.value = obj.q;
        chargeVal.textContent = obj.q.toFixed(1);
        chargeSlider.disabled = false;
        fixedCheck.checked = obj.fixed;
        fixedCheck.disabled = false;
        massSlider.value = obj.mass;
        massVal.textContent = obj.mass.toFixed(1);
        massSlider.disabled = false;
    } else if (obj.type === "plate") {
        if (rowCharge) rowCharge.style.display = "flex";
        chargeSlider.value = obj.sigma;
        chargeVal.textContent = obj.sigma.toFixed(2);
        chargeSlider.disabled = false;
    } else if (obj.type === "metalBall") {
        if (rowCharge) rowCharge.style.display = "flex";
        chargeSlider.value = obj.q;
        chargeVal.textContent = obj.q.toFixed(1);
        chargeSlider.disabled = false;
    } else if (obj.type === "insulator") {
        if (rowCharge) rowCharge.style.display = "flex";
        chargeSlider.value = obj.q;
        chargeVal.textContent = obj.q.toFixed(1);
        chargeSlider.disabled = false;
    } else if (obj.type === "barMagnet") {
        if (rowStrength) rowStrength.style.display = "flex";
        if (rowAngle) rowAngle.style.display = "flex";
        strengthSlider.value = obj.strength;
        strengthVal.textContent = obj.strength.toFixed(1);
        strengthSlider.disabled = false;
        angleSlider.value = obj.angle * 180 / Math.PI;
        angleVal.textContent = Math.round(obj.angle * 180 / Math.PI) + "°";
        angleSlider.disabled = false;
    } else if (obj.type === "electromagnet") {
        if (rowCurrent) rowCurrent.style.display = "flex";
        if (rowAngle) rowAngle.style.display = "flex";
        currentSlider.value = obj.current;
        currentVal.textContent = obj.current.toFixed(1);
        currentSlider.disabled = false;
        angleSlider.value = obj.angle * 180 / Math.PI;
        angleVal.textContent = Math.round(obj.angle * 180 / Math.PI) + "°";
        angleSlider.disabled = false;
    } else if (obj.type === "helmholtz") {
        if (rowCurrent) rowCurrent.style.display = "flex";
        currentSlider.value = obj.current;
        currentVal.textContent = obj.current.toFixed(1);
        currentSlider.disabled = false;
    } else if (obj.type === "ironCore") {
        // 铁芯：无特殊可调参数
    } else if (obj.type === "uniformBField") {
        if (rowCurrent) rowCurrent.style.display = "flex";
        if (rowStrength) {
            rowStrength.style.display = "flex";
            // 复用strength slider作为Bz强度
            strengthSlider.min = -10;
            strengthSlider.max = 10;
            strengthSlider.step = 0.1;
            strengthSlider.value = obj.bz;
            strengthVal.textContent = obj.bz.toFixed(1);
            strengthSlider.disabled = false;
        }
    } else if (obj.type === "oscEDipole") {
        // 交变电偶极子：显示频率和振幅
        if (rowCharge) rowCharge.style.display = "flex";
        chargeSlider.min = 0.1;
        chargeSlider.max = 5;
        chargeSlider.step = 0.1;
        chargeSlider.value = obj.chargeAmplitude;
        chargeVal.textContent = obj.chargeAmplitude.toFixed(1);
        chargeSlider.disabled = false;
        if (rowStrength) rowStrength.style.display = "flex";
        if (rowCurrent) rowCurrent.style.display = "flex";
        strengthSlider.min = 0.1;
        strengthSlider.max = 5;
        strengthSlider.step = 0.1;
        strengthSlider.value = obj.wfConfig.frequency;
        strengthVal.textContent = obj.wfConfig.frequency.toFixed(1) + "Hz";
        strengthSlider.disabled = false;
        currentSlider.min = -10;
        currentSlider.max = 10;
        currentSlider.step = 0.1;
        currentSlider.value = obj.separation;
        currentVal.textContent = obj.separation.toFixed(0);
        currentSlider.disabled = false;
    } else if (obj.type === "oscMDipole") {
        if (rowStrength) rowStrength.style.display = "flex";
        if (rowCurrent) rowCurrent.style.display = "flex";
        strengthSlider.min = 0.1;
        strengthSlider.max = 10;
        strengthSlider.step = 0.1;
        strengthSlider.value = obj.momentAmplitude;
        strengthVal.textContent = obj.momentAmplitude.toFixed(1);
        strengthSlider.disabled = false;
        currentSlider.min = 0.1;
        currentSlider.max = 5;
        currentSlider.step = 0.1;
        currentSlider.value = obj.wfConfig.frequency;
        currentVal.textContent = obj.wfConfig.frequency.toFixed(1) + "Hz";
        currentSlider.disabled = false;
    } else if (obj.type === "timeVaryingEField" || obj.type === "timeVaryingBField") {
        if (rowStrength) rowStrength.style.display = "flex";
        if (rowCurrent) rowCurrent.style.display = "flex";
        strengthSlider.min = 0.1;
        strengthSlider.max = 5;
        strengthSlider.step = 0.1;
        strengthSlider.value = obj.wfConfig.frequency;
        strengthVal.textContent = obj.wfConfig.frequency.toFixed(1) + "Hz";
        strengthSlider.disabled = false;
        if (obj.type === "timeVaryingEField") {
            currentSlider.min = 0.1;
            currentSlider.max = 10;
            currentSlider.step = 0.1;
            currentSlider.value = obj.eAmplitude;
            currentVal.textContent = obj.eAmplitude.toFixed(1);
        } else {
            currentSlider.min = 0.1;
            currentSlider.max = 10;
            currentSlider.step = 0.1;
            currentSlider.value = obj.bzAmplitude;
            currentVal.textContent = obj.bzAmplitude.toFixed(1);
        }
        currentSlider.disabled = false;
    } else if (obj.type === "eddyRing" || obj.type === "polarDisk" || obj.type === "fluxProbe") {
        if (rowStrength) rowStrength.style.display = "flex";
        strengthSlider.min = 10;
        strengthSlider.max = 100;
        strengthSlider.step = 1;
        strengthSlider.value = obj.radius;
        strengthVal.textContent = obj.radius.toFixed(0) + "px";
        strengthSlider.disabled = false;
    } else if (obj.type === "inducedProbe" || obj.type === "dispCurrentProbe") {
        // 无特殊可调参数
    }
}

// 属性面板事件
document.getElementById("propCharge").addEventListener("input", function () {
    const val = parseFloat(this.value);
    document.getElementById("propChargeVal").textContent = val.toFixed(1);
    if (selectedObject) {
        if (selectedObject.type === "charge" || selectedObject.type === "insulator") {
            selectedObject.q = val;
            if (selectedObject.type === "charge") {
                selectedObject.mass = Math.abs(val) * 1.0;
                selectedObject.radius = 10 + Math.abs(val) * 3;
            }
        } else if (selectedObject.type === "plate") {
            selectedObject.sigma = val;
            selectedObject.generateSamples();
        } else if (selectedObject.type === "metalBall") {
            selectedObject.q = val;
        } else if (selectedObject.type === "oscEDipole") {
            selectedObject.chargeAmplitude = val;
        }
    }
});

document.getElementById("propFixed").addEventListener("change", function () {
    if (selectedObject && selectedObject.type === "charge") {
        selectedObject.fixed = this.checked;
    }
});

document.getElementById("propMass").addEventListener("input", function () {
    const val = parseFloat(this.value);
    document.getElementById("propMassVal").textContent = val.toFixed(1);
    if (selectedObject && selectedObject.type === "charge") {
        selectedObject.mass = val;
    }
});

document.getElementById("btnDelete").addEventListener("click", function () {
    removeObject(selectedObject);
});

// 磁场属性面板事件
document.getElementById("propStrength").addEventListener("input", function () {
    const val = parseFloat(this.value);
    document.getElementById("propStrengthVal").textContent = val.toFixed(1);
    if (selectedObject) {
        if (selectedObject.type === "barMagnet") {
            selectedObject.strength = val;
            selectedObject.updateMoment();
        } else if (selectedObject.type === "uniformBField") {
            selectedObject.bz = val;
        } else if (selectedObject.type === "oscEDipole") {
            selectedObject.wfConfig.frequency = val;
            document.getElementById("propStrengthVal").textContent = val.toFixed(1) + "Hz";
        } else if (selectedObject.type === "oscMDipole") {
            selectedObject.momentAmplitude = val;
        } else if (selectedObject.type === "timeVaryingEField" || selectedObject.type === "timeVaryingBField") {
            selectedObject.wfConfig.frequency = val;
            document.getElementById("propStrengthVal").textContent = val.toFixed(1) + "Hz";
        } else if (selectedObject.type === "eddyRing" || selectedObject.type === "polarDisk" || selectedObject.type === "fluxProbe") {
            selectedObject.radius = val;
            document.getElementById("propStrengthVal").textContent = val.toFixed(0) + "px";
        }
    }
});

document.getElementById("propCurrent").addEventListener("input", function () {
    const val = parseFloat(this.value);
    document.getElementById("propCurrentVal").textContent = val.toFixed(1);
    if (selectedObject) {
        if (selectedObject.type === "electromagnet") {
            selectedObject.current = val;
        } else if (selectedObject.type === "helmholtz") {
            selectedObject.current = val;
        } else if (selectedObject.type === "oscEDipole") {
            selectedObject.separation = val;
            document.getElementById("propCurrentVal").textContent = val.toFixed(0);
        } else if (selectedObject.type === "oscMDipole") {
            selectedObject.wfConfig.frequency = val;
            document.getElementById("propCurrentVal").textContent = val.toFixed(1) + "Hz";
        } else if (selectedObject.type === "timeVaryingEField") {
            selectedObject.eAmplitude = val;
        } else if (selectedObject.type === "timeVaryingBField") {
            selectedObject.bzAmplitude = val;
        }
    }
});

document.getElementById("propAngle").addEventListener("input", function () {
    const val = parseFloat(this.value);
    document.getElementById("propAngleVal").textContent = Math.round(val) + "°";
    if (selectedObject) {
        if (selectedObject.type === "barMagnet") {
            selectedObject.angle = val * Math.PI / 180;
            selectedObject.updateMoment();
        } else if (selectedObject.type === "electromagnet") {
            selectedObject.angle = val * Math.PI / 180;
        } else if (selectedObject.type === "oscEDipole" || selectedObject.type === "oscMDipole") {
            selectedObject.angle = val * Math.PI / 180;
        } else if (selectedObject.type === "timeVaryingEField") {
            selectedObject.eAngle = val * Math.PI / 180;
        }
    }
});

// ==================== 工具切换 ====================
function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tool === tool);
    });
    const toolNames = {
        "charge-positive": "正电荷 — 点击画布放置",
        "charge-negative": "负电荷 — 点击画布放置",
        "plate": "带电平板 — 拖拽画布定义区域",
        "metal-ball": "金属球 — 点击画布放置",
        "insulator": "绝缘块 — 点击画布放置",
        "eprobe": "电场探针 — 点击画布放置",
        "vprobe": "电势探针 — 点击画布放置",
        "bar-magnet": "条形磁铁 — 点击放置，右键旋转方向",
        "electromagnet": "电磁铁 — 点击放置，右键旋转方向",
        "helmholtz": "亥姆霍兹线圈 — 点击画布放置",
        "rect-bfield": "方形B场 — 拖拽画布定义区域",
        "circle-bfield": "圆形B场 — 点击画布放置",
        "iron-core": "铁芯 — 点击画布放置",
        "bprobe": "磁场探针 — 点击画布放置",
        "osc-edipole": "交变电偶极子 — 点击放置",
        "osc-mdipole": "交变磁偶极子 — 点击放置",
        "tvefield": "时变E场 — 拖拽画布定义区域",
        "tvbfield": "时变B场 — 拖拽画布定义区域",
        "eddy-ring": "涡流环 — 点击画布放置",
        "polar-disk": "极化涡旋盘 — 点击画布放置",
        "induced-probe": "感生场探针 — 点击画布放置",
        "disp-probe": "位移电流探针 — 点击画布放置",
        "flux-probe": "磁通变化率探针 — 点击画布放置",
    };
    document.getElementById("toolInfo").textContent = "当前工具: " + (toolNames[tool] || tool);
    selectObject(null);
    platePlaceStart = null;
}

document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
});

// ==================== 画布交互 ====================
canvas.addEventListener("mousedown", (e) => {
    const mx = e.clientX;
    const my = e.clientY;

    // 先检查是否点击了已有物体
    const hit = findObjectAt(mx, my);
    if (hit) {
        selectObject(hit);
        hit.dragging = true;
        isDragging = true;
        dragStartX = mx;
        dragStartY = my;
        return;
    }

    selectObject(null);

    // 根据当前工具创建新物体
    if (currentTool === "charge-positive") {
        charges.push(new Charge(mx, my, 1));
    } else if (currentTool === "charge-negative") {
        charges.push(new Charge(mx, my, -1));
    } else if (currentTool === "plate") {
        platePlaceStart = { x: mx, y: my };
    } else if (currentTool === "metal-ball") {
        metalBalls.push(new MetalBall(mx, my, 25 + Math.random() * 10));
    } else if (currentTool === "insulator") {
        insulators.push(new InsulatorBlock(mx, my, 30, 20));
    } else if (currentTool === "eprobe") {
        probes.push(new Probe(mx, my, "E"));
    } else if (currentTool === "vprobe") {
        probes.push(new Probe(mx, my, "V"));
    } else if (currentTool === "bprobe") {
        probes.push(new Probe(mx, my, "B"));
    } else if (currentTool === "bar-magnet") {
        barMagnets.push(new BarMagnet(mx, my, 3, magnetPlaceAngle));
    } else if (currentTool === "electromagnet") {
        electromagnets.push(new Electromagnet(mx, my, 3, 5, magnetPlaceAngle));
    } else if (currentTool === "helmholtz") {
        helmholtzCoils.push(new HelmholtzCoil(mx, my, 3, 40));
    } else if (currentTool === "iron-core") {
        ironCores.push(new IronCore(mx, my, 30, 60));
    } else if (currentTool === "rect-bfield") {
        platePlaceStart = { x: mx, y: my }; // 复用平板拖拽机制
    } else if (currentTool === "circle-bfield") {
        uniformBFields.push(new UniformBFieldRegion(mx, my, "circle", 50, 50, 1));
    } else if (currentTool === "osc-edipole") {
        oscEDipoles.push(new OscillatingElectricDipole(mx, my, 1, 30, magnetPlaceAngle,
            new WaveformConfig("sine", 0.5, 0, 1)));
    } else if (currentTool === "osc-mdipole") {
        oscMDipoles.push(new OscillatingMagneticDipole(mx, my, 3, magnetPlaceAngle,
            new WaveformConfig("sine", 0.5, 0, 1)));
    } else if (currentTool === "tvefield") {
        platePlaceStart = { x: mx, y: my };
    } else if (currentTool === "tvbfield") {
        platePlaceStart = { x: mx, y: my };
    } else if (currentTool === "eddy-ring") {
        eddyRings.push(new EddyCurrentRing(mx, my, 35));
    } else if (currentTool === "polar-disk") {
        polarDisks.push(new PolarizationVortexDisk(mx, my, 30));
    } else if (currentTool === "induced-probe") {
        inducedProbes.push(new InducedFieldProbe(mx, my));
    } else if (currentTool === "disp-probe") {
        dispCurrentProbes.push(new DisplacementCurrentProbe(mx, my));
    } else if (currentTool === "flux-probe") {
        fluxProbes.push(new FluxChangeProbe(mx, my, 30));
    }
});

canvas.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;

    if (isDragging && selectedObject) {
        selectedObject.x = mouseX;
        selectedObject.y = mouseY;
    }

    // 更新hover状态
    hoveredObject = findObjectAt(mouseX, mouseY);
    if (isDragging) hoveredObject = selectedObject;
    canvas.style.cursor = hoveredObject ? "grab" : "crosshair";
});

canvas.addEventListener("mouseup", (e) => {
    if (isDragging && selectedObject) {
        selectedObject.dragging = false;
        // 给电荷一个初始速度（拖拽释放惯性）
        if (selectedObject.type === "charge" && !selectedObject.fixed) {
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            selectedObject.vx = dx * 3;
            selectedObject.vy = dy * 3;
        }
    }

    // 平板放置完成
    if (platePlaceStart && currentTool === "plate") {
        const mx = e.clientX;
        const my = e.clientY;
        const w = Math.abs(mx - platePlaceStart.x);
        const h = Math.abs(my - platePlaceStart.y);
        if (w > 10 && h > 10) {
            const cx = (platePlaceStart.x + mx) / 2;
            const cy = (platePlaceStart.y + my) / 2;
            plates.push(new ChargedPlate(cx, cy, w, h, 0.01));
        }
        platePlaceStart = null;
    }

    // 方形B场放置完成
    if (platePlaceStart && currentTool === "rect-bfield") {
        const mx = e.clientX;
        const my = e.clientY;
        const w = Math.abs(mx - platePlaceStart.x);
        const h = Math.abs(my - platePlaceStart.y);
        if (w > 15 && h > 15) {
            const cx = (platePlaceStart.x + mx) / 2;
            const cy = (platePlaceStart.y + my) / 2;
            uniformBFields.push(new UniformBFieldRegion(cx, cy, "rect", w, h, 1));
        }
        platePlaceStart = null;
    }

    // 时变E场区域放置完成
    if (platePlaceStart && currentTool === "tvefield") {
        const mx = e.clientX;
        const my = e.clientY;
        const w = Math.abs(mx - platePlaceStart.x);
        const h = Math.abs(my - platePlaceStart.y);
        if (w > 15 && h > 15) {
            const cx = (platePlaceStart.x + mx) / 2;
            const cy = (platePlaceStart.y + my) / 2;
            timeVaryingEFields.push(new TimeVaryingEFieldRegion(cx, cy, w, h, 1, 0,
                new WaveformConfig("sine", 0.5, 0, 1)));
        }
        platePlaceStart = null;
    }

    // 时变B场区域放置完成
    if (platePlaceStart && currentTool === "tvbfield") {
        const mx = e.clientX;
        const my = e.clientY;
        const w = Math.abs(mx - platePlaceStart.x);
        const h = Math.abs(my - platePlaceStart.y);
        if (w > 15 && h > 15) {
            const cx = (platePlaceStart.x + mx) / 2;
            const cy = (platePlaceStart.y + my) / 2;
            timeVaryingBFields.push(new TimeVaryingBFieldRegion(cx, cy, w, h, 1,
                new WaveformConfig("sine", 0.5, 0, 1)));
        }
        platePlaceStart = null;
    }

    isDragging = false;
});

// 触摸支持
canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mx = touch.clientX;
    const my = touch.clientY;
    const hit = findObjectAt(mx, my);
    if (hit) {
        selectObject(hit);
        hit.dragging = true;
        isDragging = true;
        dragStartX = mx;
        dragStartY = my;
    }
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (isDragging && selectedObject) {
        const touch = e.touches[0];
        selectedObject.x = touch.clientX;
        selectedObject.y = touch.clientY;
    }
}, { passive: false });

canvas.addEventListener("touchend", (e) => {
    if (isDragging && selectedObject) {
        selectedObject.dragging = false;
    }
    isDragging = false;
});

// 键盘快捷键
window.addEventListener("keydown", (e) => {
    switch (e.key.toLowerCase()) {
        case "delete":
        case "backspace":
            removeObject(selectedObject);
            break;
        case "p":
            paused = !paused;
            document.getElementById("btnPause").textContent = paused ? "▶ 播放" : "⏯ 暂停";
            break;
        case "f":
            if (selectedObject && selectedObject.type === "charge") {
                selectedObject.fixed = !selectedObject.fixed;
                document.getElementById("propFixed").checked = selectedObject.fixed;
            }
            break;
        case "r":
            // 旋转选中的磁铁/偶极子
            if (selectedObject && (selectedObject.type === "barMagnet" ||
                selectedObject.type === "electromagnet" ||
                selectedObject.type === "oscMDipole" ||
                selectedObject.type === "oscEDipole")) {
                if (selectedObject.type === "barMagnet") {
                    selectedObject.angle += Math.PI / 8;
                    selectedObject.updateMoment();
                } else if (selectedObject.type === "electromagnet") {
                    selectedObject.angle += Math.PI / 8;
                } else if (selectedObject.type === "oscMDipole") {
                    selectedObject.angle += Math.PI / 8;
                } else if (selectedObject.type === "oscEDipole") {
                    selectedObject.angle += Math.PI / 8;
                }
                document.getElementById("propAngle").value =
                    Math.round(selectedObject.angle * 180 / Math.PI);
                document.getElementById("propAngleVal").textContent =
                    Math.round(selectedObject.angle * 180 / Math.PI) + "°";
            }
            break;
        case "t":
            // 切换电磁铁开关
            if (selectedObject && selectedObject.type === "electromagnet") {
                selectedObject.active = !selectedObject.active;
            }
            break;
        case "1":
            setTool("charge-positive");
            break;
        case "2":
            setTool("charge-negative");
            break;
        case "3":
            setTool("plate");
            break;
        case "4":
            setTool("metal-ball");
            break;
        case "5":
            setTool("insulator");
            break;
        case "6":
            setTool("eprobe");
            break;
        case "7":
            setTool("vprobe");
            break;
        case "8":
            setTool("bar-magnet");
            magnetPlaceAngle = 0;
            break;
        case "9":
            setTool("electromagnet");
            magnetPlaceAngle = 0;
            break;
        case "0":
            setTool("bprobe");
            break;
        case "-":
            setTool("rect-bfield");
            break;
        case "=":
            setTool("circle-bfield");
            break;
        case "[":
            setTool("osc-edipole");
            magnetPlaceAngle = 0;
            break;
        case "]":
            setTool("osc-mdipole");
            magnetPlaceAngle = 0;
            break;
        case ";":
            setTool("tvefield");
            break;
        case "'":
            setTool("tvbfield");
            break;
        case ".":
            setTool("eddy-ring");
            break;
        case "/":
            setTool("polar-disk");
            break;
        case "escape":
            selectObject(null);
            break;
    }
});

// 右键旋转磁铁放置角度
canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (currentTool === "bar-magnet" || currentTool === "electromagnet" ||
        currentTool === "osc-edipole" || currentTool === "osc-mdipole") {
        magnetPlaceAngle += Math.PI / 6;
        const deg = Math.round(magnetPlaceAngle * 180 / Math.PI) % 360;
        const nameMap = {
            "bar-magnet": "条形磁铁",
            "electromagnet": "电磁铁",
            "osc-edipole": "交变电偶极子",
            "osc-mdipole": "交变磁偶极子"
        };
        document.getElementById("toolInfo").textContent =
            `当前工具: ${nameMap[currentTool]} — 角度: ${deg}° (右键旋转)`;
    }
});

// ==================== UI 按钮事件 ====================
document.getElementById("btnPause").addEventListener("click", function () {
    paused = !paused;
    this.textContent = paused ? "▶ 播放" : "⏯ 暂停";
});

document.getElementById("btnClear").addEventListener("click", clearAll);

document.getElementById("toggleField").addEventListener("change", function () {
    showFieldLines = this.checked;
});

document.getElementById("toggleEquipotential").addEventListener("change", function () {
    showEquipotential = this.checked;
});

document.getElementById("toggleGrid").addEventListener("change", function () {
    showGrid = this.checked;
});

document.getElementById("toggleBField").addEventListener("change", function () {
    showBFieldLines = this.checked;
});

document.getElementById("toggleInducedField").addEventListener("change", function () {
    showInducedFields = this.checked;
});

// ==================== 预置场景 ====================
function loadPreset(name) {
    clearAll();

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    switch (name) {
        case "pendulum":
            // 静电摆：两个同号电荷球用线悬挂
            const pivotX = cx;
            const pivotY = cy - 150;
            charges.push(new Charge(pivotX - 50, pivotY + 100, 2, false));
            charges.push(new Charge(pivotX + 50, pivotY + 100, 2, false));
            // 上方固定同号电荷使它们偏转
            charges.push(new Charge(pivotX, pivotY - 80, 4, true));
            break;

        case "hovercraft":
            // 电荷飞船：平台和底座同号电荷悬浮
            const baseX = cx;
            const baseY = cy + 150;
            for (let i = -2; i <= 2; i++) {
                charges.push(new Charge(baseX + i * 30, baseY, 3, true));
            }
            const shipY = cy - 50;
            charges.push(new Charge(cx - 30, shipY, 1, false));
            charges.push(new Charge(cx + 30, shipY, 1, false));
            charges.push(new Charge(cx, shipY, 1, false));
            // 上方引导电荷
            charges.push(new Charge(cx, cy - 200, -2, true));
            break;

        case "maze":
            // 电场迷宫：布置电荷阵列
            const gridSize = 4;
            const spacing = 100;
            const startX = cx - (gridSize - 1) * spacing / 2;
            const startY = cy - (gridSize - 1) * spacing / 2;
            for (let i = 0; i < gridSize; i++) {
                for (let j = 0; j < gridSize; j++) {
                    const q = (Math.random() > 0.5 ? 1 : -1) * (1 + Math.random() * 2);
                    charges.push(new Charge(
                        startX + i * spacing + (Math.random() - 0.5) * 30,
                        startY + j * spacing + (Math.random() - 0.5) * 30,
                        q,
                        true
                    ));
                }
            }
            // 放入一个自由电荷
            charges.push(new Charge(cx, cy - 200, 1, false));
            // 添加探针
            probes.push(new Probe(cx, cy, "V"));
            break;

        case "trap":
            // 静电陷阱：四周围住自由电荷
            const trapR = 120;
            const n = 8;
            for (let i = 0; i < n; i++) {
                const angle = (i / n) * Math.PI * 2;
                charges.push(new Charge(
                    cx + Math.cos(angle) * trapR,
                    cy + Math.sin(angle) * trapR,
                    i % 2 === 0 ? 3 : -3,
                    true
                ));
            }
            // 被困的电荷
            charges.push(new Charge(cx, cy, 1, false));
            break;

        case "cyclotron":
            // 电子在磁场中的圆周运动
            // 圆形均匀B场区域
            uniformBFields.push(new UniformBFieldRegion(cx, cy, "circle", 160, 160, 3));
            // 发射快速移动的电荷
            const electron = new Charge(cx - 100, cy, 1);
            electron.vx = 60;
            electron.vy = 0;
            charges.push(electron);
            // 不同速度/电荷的粒子
            const e2 = new Charge(cx - 100, cy - 35, -1);
            e2.vx = 90;
            e2.vy = 0;
            charges.push(e2);
            const e3 = new Charge(cx - 100, cy + 35, 1);
            e3.vx = 40;
            e3.vy = 0;
            charges.push(e3);
            // B场探针
            probes.push(new Probe(cx, cy, "B"));
            break;

        case "velocity-selector":
            // 速度选择器：交叉E场和B场
            // 带电平板产生向下的E场
            plates.push(new ChargedPlate(cx, cy - 80, 300, 20, 0.05));
            plates.push(new ChargedPlate(cx, cy + 80, 300, 20, -0.05));
            // 方形均匀B场区域（出页面Bz）
            uniformBFields.push(new UniformBFieldRegion(cx, cy, "rect", 320, 100, 1.5));
            // 发射不同速度的粒子
            for (let i = 0; i < 5; i++) {
                const particle = new Charge(cx - 180, cy + (i - 2) * 18, 1);
                particle.vx = 40 + i * 25;
                particle.vy = 0;
                charges.push(particle);
            }
            probes.push(new Probe(cx + 80, cy, "E"));
            probes.push(new Probe(cx + 80, cy + 25, "B"));
            break;

        case "maglev":
            // 磁悬浮陀螺
            const ringR = 50;
            const nMags = 6;
            for (let i = 0; i < nMags; i++) {
                const ang = (i / nMags) * Math.PI * 2;
                barMagnets.push(new BarMagnet(
                    cx + Math.cos(ang) * ringR,
                    cy + Math.sin(ang) * ringR + 80,
                    4,
                    ang + Math.PI / 2  // 指向中心
                ));
            }
            // 悬浮的磁铁
            barMagnets.push(new BarMagnet(cx, cy - 20, 3, Math.PI / 2));
            // 一些铁芯增强磁场
            ironCores.push(new IronCore(cx, cy + 80, 10, 30));
            break;

        case "crt":
            // 阴极射线管模型
            // 加速电场（带电平板）
            plates.push(new ChargedPlate(cx - 180, cy, 20, 80, 0.1));
            plates.push(new ChargedPlate(cx - 120, cy, 20, 80, -0.1));
            // 偏转磁场（电磁铁）
            electromagnets.push(new Electromagnet(cx + 50, cy, 3, 5, 0));
            // 荧光屏（金属板）
            metalBalls.push(new MetalBall(cx + 200, cy - 30, 15));
            metalBalls.push(new MetalBall(cx + 200, cy, 15));
            metalBalls.push(new MetalBall(cx + 200, cy + 30, 15));
            // 发射电子
            const beam = new Charge(cx - 250, cy, -0.5);
            beam.vx = 200;
            beam.vy = 0;
            beam.mass = 0.1;
            beam.radius = 5;
            charges.push(beam);
            // 持续发射（通过多个电子模拟）
            for (let i = 0; i < 10; i++) {
                const eb = new Charge(cx - 250 - i * 20, cy + (Math.random() - 0.5) * 10, -0.5);
                eb.vx = 200;
                eb.vy = (Math.random() - 0.5) * 10;
                eb.mass = 0.1;
                eb.radius = 5;
                charges.push(eb);
            }
            break;

        // ==================== 阶段三预置场景 ====================

        case "induction-ring":
            // 无导线的感应加速环
            // 中央时变磁偶极子（磁场垂直纸面，正弦变化）
            oscMDipoles.push(new OscillatingMagneticDipole(cx, cy, 5, 0,
                new WaveformConfig("sine", 0.8, 0, 1)));
            // 周围放置一些自由电荷，它们会被感生电场加速绕圈
            for (let i = 0; i < 4; i++) {
                const ang = (i / 4) * Math.PI * 2;
                const r = 80 + i * 30;
                const testCharge = new Charge(
                    cx + Math.cos(ang) * r,
                    cy + Math.sin(ang) * r,
                    0.5
                );
                testCharge.vx = -Math.sin(ang) * 15;
                testCharge.vy = Math.cos(ang) * 15;
                charges.push(testCharge);
            }
            // 涡流环展示感生电场
            eddyRings.push(new EddyCurrentRing(cx, cy, 100));
            eddyRings.push(new EddyCurrentRing(cx, cy, 60));
            // 感生场探针
            inducedProbes.push(new InducedFieldProbe(cx + 80, cy));
            break;

        case "disp-mirror":
            // 位移电流"磁力镜"
            // 两个平行板（不连接电源），带有时变电量
            plates.push(new ChargedPlate(cx - 60, cy, 15, 120, 0.01));
            plates.push(new ChargedPlate(cx + 60, cy, 15, 120, -0.01));
            // 交变电偶极子产生变化电场
            oscEDipoles.push(new OscillatingElectricDipole(cx, cy, 2, 60, 0,
                new WaveformConfig("sine", 1.0, 0, 1)));
            // 磁探针放在板间真空中
            probes.push(new Probe(cx, cy - 30, "B"));
            probes.push(new Probe(cx, cy + 30, "B"));
            // 位移电流探针
            dispCurrentProbes.push(new DisplacementCurrentProbe(cx + 10, cy));
            // 极化涡旋盘展示感生B场
            polarDisks.push(new PolarizationVortexDisk(cx, cy - 50, 25));
            polarDisks.push(new PolarizationVortexDisk(cx, cy + 50, 25));
            break;

        case "field-resonator":
            // 场耦合谐振器（近场能量无线传输）
            // 发射端：交变电偶极子
            oscEDipoles.push(new OscillatingElectricDipole(cx - 200, cy, 1.5, 35, 0,
                new WaveformConfig("sine", 0.6, 0, 1)));
            // 接收端：交变磁偶极子（距离发射端一定距离）
            oscMDipoles.push(new OscillatingMagneticDipole(cx + 200, cy, 3, Math.PI / 2,
                new WaveformConfig("sine", 0.6, 0, 0.8)));
            // 中间放置探针观察场耦合
            inducedProbes.push(new InducedFieldProbe(cx, cy));
            dispCurrentProbes.push(new DisplacementCurrentProbe(cx + 50, cy - 40));
            fluxProbes.push(new FluxChangeProbe(cx + 200, cy, 50));
            // 时变B场区域展示中间耦合区
            timeVaryingBFields.push(new TimeVaryingBFieldRegion(cx, cy, 120, 60, 0.5,
                new WaveformConfig("sine", 0.6, 0, 0.5)));
            // 自由电荷观察能量传递
            const flyCharge = new Charge(cx, cy - 80, 0.3);
            charges.push(flyCharge);
            break;
    }
}

document.querySelectorAll(".preset-btn[data-preset]").forEach(btn => {
    btn.addEventListener("click", () => loadPreset(btn.dataset.preset));
});

// ==================== 主循环 ====================
function update() {
    if (paused) return;

    // 推进模拟时间
    simTime += DT;

    // 更新感应电荷
    for (const mb of metalBalls) {
        mb.updateInduced();
    }

    // 测量涡流环感生电动势
    for (const er of eddyRings) {
        er.measureInduced();
    }

    // 测量极化涡旋盘感生B场
    for (const pd of polarDisks) {
        pd.measureInduced();
    }

    // 更新电荷物理
    for (const c of charges) {
        c.update();
    }

    // 电荷间碰撞处理
    for (let i = 0; i < charges.length; i++) {
        for (let j = i + 1; j < charges.length; j++) {
            const a = charges[i];
            const b = charges[j];
            const d2 = dist2(a.x, a.y, b.x, b.y);
            const minDist = a.radius + b.radius;
            if (d2 < minDist * minDist) {
                const d = Math.sqrt(d2) || 1;
                const overlap = minDist - d;
                const nx = (b.x - a.x) / d;
                const ny = (b.y - a.y) / d;

                if (!a.fixed && !b.fixed) {
                    a.x -= nx * overlap / 2;
                    a.y -= ny * overlap / 2;
                    b.x += nx * overlap / 2;
                    b.y += ny * overlap / 2;
                    // 弹性碰撞
                    const dvx = a.vx - b.vx;
                    const dvy = a.vy - b.vy;
                    const dvDotN = dvx * nx + dvy * ny;
                    if (dvDotN > 0) {
                        a.vx -= dvDotN * nx;
                        a.vy -= dvDotN * ny;
                        b.vx += dvDotN * nx;
                        b.vy += dvDotN * ny;
                    }
                } else if (!a.fixed) {
                    a.x -= nx * overlap;
                    a.y -= ny * overlap;
                    a.vx *= -0.3;
                    a.vy *= -0.3;
                } else if (!b.fixed) {
                    b.x += nx * overlap;
                    b.y += ny * overlap;
                    b.vx *= -0.3;
                    b.vy *= -0.3;
                }
            }
        }
    }

    // 更新探针测量值
    for (const p of probes) {
        p.measure();
    }
    for (const ip of inducedProbes) {
        ip.measure();
    }
    for (const dp of dispCurrentProbes) {
        dp.measure();
    }
    for (const fp of fluxProbes) {
        fp.measure();
    }
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 背景网格
    drawGrid();

    // 等势面
    drawEquipotential();

    // 电场线
    drawFieldLines();

    // 磁感线（Bz热力图 + 面内箭头）
    drawBFieldLines();

    // 涡旋场可视化（阶段三）
    if (showInducedFields) {
        drawInducedFieldLines();
    }

    // 画所有物体（从底层到顶层）
    // 底层：区域型元件
    for (const tvb of timeVaryingBFields) { tvb.draw(ctx); }
    for (const tve of timeVaryingEFields) { tve.draw(ctx); }
    for (const ic of ironCores) { ic.draw(ctx); }
    for (const hc of helmholtzCoils) { hc.draw(ctx); }
    for (const ubf of uniformBFields) { ubf.draw(ctx); }
    // 中层：固体元件
    for (const ins of insulators) { ins.draw(ctx); }
    for (const mb of metalBalls) { mb.draw(ctx); }
    for (const p of plates) { p.draw(ctx); }
    for (const bm of barMagnets) { bm.draw(ctx); }
    for (const em of electromagnets) { em.draw(ctx); }
    // 阶段三：时变源
    for (const oed of oscEDipoles) { oed.draw(ctx); }
    for (const omd of oscMDipoles) { omd.draw(ctx); }
    // 阶段三：被动感应体
    for (const er of eddyRings) { er.draw(ctx); }
    for (const pd of polarDisks) { pd.draw(ctx); }
    // 顶层：电荷和探针
    for (const c of charges) { c.draw(ctx); }
    for (const p of probes) { p.draw(ctx); }
    for (const ip of inducedProbes) { ip.draw(ctx); }
    for (const dp of dispCurrentProbes) { dp.draw(ctx); }
    for (const fp of fluxProbes) { fp.draw(ctx); }

    // 平板/B场区域放置预览
    if (platePlaceStart && (currentTool === "plate" || currentTool === "rect-bfield" ||
        currentTool === "tvefield" || currentTool === "tvbfield")) {
        const w = mouseX - platePlaceStart.x;
        const h = mouseY - platePlaceStart.y;
        const isTVE = currentTool === "tvefield";
        const isTVB = currentTool === "tvbfield";
        const isB = currentTool === "rect-bfield" || isTVB;

        ctx.strokeStyle = isTVE ? "rgba(255,200,80,0.6)" :
            isTVB ? "rgba(100,200,255,0.6)" :
            isB ? "rgba(100,180,255,0.6)" : "rgba(255,200,50,0.6)";
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(platePlaceStart.x, platePlaceStart.y, w, h);
        ctx.setLineDash([]);

        const fillColor = isTVE ? "rgba(255,200,80,0.04)" :
            isTVB ? "rgba(100,200,255,0.04)" :
            isB ? "rgba(100,180,255,0.06)" : "";
        if (fillColor) {
            ctx.fillStyle = fillColor;
            ctx.fillRect(platePlaceStart.x, platePlaceStart.y, w, h);
        }
    }

    // 时间指示器
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.textAlign = "right";
    ctx.fillText(`t=${simTime.toFixed(1)}s`, canvas.width - 16, canvas.height - 30);

    // 状态栏
    document.getElementById("info").textContent =
        `电荷:${charges.length} | 平板:${plates.length} | 磁铁:${barMagnets.length} | 电磁铁:${electromagnets.length} | 线圈:${helmholtzCoils.length} | B场区:${uniformBFields.length} | 时变源:${oscEDipoles.length + oscMDipoles.length + timeVaryingEFields.length + timeVaryingBFields.length} | 探针:${probes.length}`;

    // 探针信息
    const eProbe = probes.find(p => p.probeType === "E");
    const vProbe = probes.find(p => p.probeType === "V");
    const bProbe = probes.find(p => p.probeType === "B");
    let probeText = "";
    if (eProbe) {
        const Emag = Math.sqrt(eProbe.measuredEx ** 2 + eProbe.measuredEy ** 2);
        probeText += `E场: |E|=${Emag.toFixed(1)} `;
    }
    if (vProbe) {
        probeText += `电势: V=${vProbe.measuredV.toFixed(1)} `;
    }
    if (bProbe) {
        const Bmag = Math.sqrt(bProbe.measuredBx ** 2 + bProbe.measuredBy ** 2 + bProbe.measuredBz ** 2);
        probeText += `B场: |B|=${Bmag.toFixed(2)} Bz=${bProbe.measuredBz.toFixed(2)}`;
    }
    if (inducedProbes.length > 0) {
        const ip = inducedProbes[0];
        const imag = Math.sqrt(ip.inducedEx ** 2 + ip.inducedEy ** 2);
        probeText += ` | 感生E: ${imag.toFixed(2)}`;
    }
    document.getElementById("probeInfo").textContent = probeText;
}

// 涡旋场可视化（阶段三）
function drawInducedFieldLines() {
    if (!showInducedFields) return;

    // 检测是否有活跃的时变场源
    const hasTimeVaryingSources =
        oscMDipoles.length > 0 || timeVaryingBFields.length > 0 ||
        oscEDipoles.length > 0 || timeVaryingEFields.length > 0 ||
        eddyRings.length > 0 || polarDisks.length > 0;

    if (!hasTimeVaryingSources) return;

    const step = INDUCED_FIELD_GRID;

    // 绘制感生电场涡旋线（品红色）
    for (let x = step / 2; x < canvas.width; x += step) {
        for (let y = step / 2; y < canvas.height; y += step) {
            // 单独计算感生电场分量（从时变B源）
            let iex = 0, iey = 0;
            for (const omd of oscMDipoles) {
                const c = omd.getInducedEFieldAt(x, y);
                iex += c.ex;
                iey += c.ey;
            }
            for (const tvb of timeVaryingBFields) {
                const c = tvb.getInducedEFieldAt(x, y);
                iex += c.ex;
                iey += c.ey;
            }
            for (const er of eddyRings) {
                const c = er.getInducedFieldAt(x, y);
                iex += c.ex;
                iey += c.ey;
            }

            const len = Math.sqrt(iex ** 2 + iey ** 2);
            if (len < 0.02) continue;

            const scale = Math.min(ARROW_SCALE * 1.2, len * 3) / len;
            const sx = iex * scale;
            const sy = iey * scale;

            // 涡旋场：品红色调和虚线
            const intensity = Math.min(len / 1.5, 1.0);
            ctx.strokeStyle = `rgba(255, ${Math.round(60 + intensity * 60)}, 255, ${0.2 + intensity * 0.3})`;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 5]);
            ctx.beginPath();
            ctx.moveTo(x - sx * 0.5, y - sy * 0.5);
            ctx.lineTo(x + sx * 0.5, y + sy * 0.5);
            ctx.stroke();
            ctx.setLineDash([]);

            // 小箭头（表示涡旋方向）
            const tipSize = 3;
            const ang = Math.atan2(sy, sx);
            ctx.beginPath();
            ctx.moveTo(x + sx * 0.5, y + sy * 0.5);
            ctx.lineTo(
                x + sx * 0.5 - tipSize * Math.cos(ang - 0.8),
                y + sy * 0.5 - tipSize * Math.sin(ang - 0.8)
            );
            ctx.lineTo(
                x + sx * 0.5 - tipSize * Math.cos(ang + 0.8),
                y + sy * 0.5 - tipSize * Math.sin(ang + 0.8)
            );
            ctx.closePath();
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
        }
    }

    // 绘制位移电流感生B场指示（青色点阵）
    for (let x = step; x < canvas.width; x += step) {
        for (let y = step; y < canvas.height; y += step) {
            let ibz = 0;
            for (const oed of oscEDipoles) {
                const c = oed.getDisplacementBFieldAt(x, y);
                ibz += c.bz;
            }
            for (const tve of timeVaryingEFields) {
                const c = tve.getDisplacementBFieldAt(x, y);
                ibz += c.bz;
            }
            for (const pd of polarDisks) {
                const c = pd.getInducedFieldAt(x, y);
                ibz += c.bz;
            }

            if (Math.abs(ibz) < 0.015) continue;

            const alpha = Math.min(Math.abs(ibz) * 3, 0.5);
            const color = ibz > 0 ?
                `rgba(100,255,200,${alpha})` :
                `rgba(255,100,200,${alpha})`;
            ctx.fillStyle = color;
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const symbol = ibz > 0 ? "⊙" : "⊗";
            ctx.fillText(symbol, x, y);
        }
    }
}

function loop() {
    requestAnimationFrame(loop);
    update();
    draw();
}

// ==================== 启动 ====================
// 初始放置几个电荷，提供一个有趣的起点
(function initScene() {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // 中心大正电荷（固定）
    charges.push(new Charge(cx, cy, 5, true));

    // 环绕的负电荷（自由运动）
    const nOrbits = 4;
    for (let i = 0; i < nOrbits; i++) {
        const ang = (i / nOrbits) * Math.PI * 2 + Math.random() * 0.3;
        const r = 150 + Math.random() * 50;
        const c = new Charge(
            cx + Math.cos(ang) * r,
            cy + Math.sin(ang) * r,
            -1
        );
        c.vx = Math.sin(ang) * 20;
        c.vy = -Math.cos(ang) * 20;
        charges.push(c);
    }

    // 外围几个固定正电荷形成电场迷宫感
    for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2 + 0.5;
        charges.push(new Charge(
            cx + Math.cos(ang) * 280,
            cy + Math.sin(ang) * 280,
            3,
            true
        ));
    }
})();

setTool("charge-positive");
loop();
