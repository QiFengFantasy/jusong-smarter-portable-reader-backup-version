import L from "leaflet";

export interface AnimatedRoute {
  layer: L.Polyline;
  /** 非动画状态下的虚线样式（solid 路线为 undefined）。 */
  baseDashArray?: string;
}

const FLOW_DASH = "9 9";

/** 用 stroke-dashoffset 做路线「流动」动画；暂停时恢复原始虚实。 */
export class RouteAnimator {
  private routes: AnimatedRoute[] = [];
  private playing = false;
  private frame: number | null = null;
  private lastTime = 0;
  private offset = 0;

  setRoutes(routes: AnimatedRoute[]): void {
    this.routes = routes;
    if (this.playing) {
      this.stopFrame();
      this.startFrame();
    } else {
      this.applyBaseStyles();
    }
  }

  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (playing) this.startFrame();
    else this.stop();
  }

  dispose(): void {
    this.stop();
    this.routes = [];
  }

  private startFrame(): void {
    this.stopFrame();
    this.offset = 0;
    this.lastTime = 0;
    for (const route of this.routes) route.layer.setStyle({ dashArray: FLOW_DASH });

    const step = (time: number) => {
      if (!this.playing) return;
      const delta = this.lastTime === 0 ? 16 : Math.min(64, time - this.lastTime);
      this.lastTime = time;
      this.offset = (this.offset + delta * 0.02) % 360;
      for (const route of this.routes) {
        const element = route.layer.getElement();
        if (element instanceof SVGElement) element.style.strokeDashoffset = String(-this.offset);
      }
      this.frame = window.requestAnimationFrame(step);
    };
    this.frame = window.requestAnimationFrame(step);
  }

  private stop(): void {
    this.stopFrame();
    this.offset = 0;
    for (const route of this.routes) {
      const element = route.layer.getElement();
      if (element instanceof SVGElement) element.style.strokeDashoffset = "0";
    }
    this.applyBaseStyles();
  }

  private applyBaseStyles(): void {
    for (const route of this.routes) {
      route.layer.setStyle({ dashArray: route.baseDashArray });
    }
  }

  private stopFrame(): void {
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }
}
