import { ModelQuality } from "@/engine/renderable/entity/unit/ModelQuality";
import { isNotNullOrUndefined } from "@/util/typeGuard";
import { VxlGeometryMonotoneBuilder } from "@/engine/renderable/builder/vxlGeometry/VxlGeometryMonotoneBuilder";
import { VxlGeometryCulledBuilder } from "@/engine/renderable/builder/vxlGeometry/VxlGeometryCulledBuilder";
export class VxlGeometryPool {
    cache: any;
    modelQuality: ModelQuality;
    constructor(cache, modelQuality = ModelQuality.High) {
        this.cache = cache;
        this.modelQuality = modelQuality;
        this.cache?.setModelQuality?.(modelQuality);
    }
    setModelQuality(modelQuality) {
        if (this.modelQuality === modelQuality) {
            return;
        }
        this.modelQuality = modelQuality;
        this.cache?.setModelQuality?.(modelQuality);
        // Quality changes mesh topology; drop in-memory geometries so next get() rebuilds.
        this.clear();
    }
    getModelQuality() {
        return this.modelQuality;
    }
    async loadFromStorage(data, param) {
        let results = await Promise.all(data.sections.map((section) => this.cache.loadFromStorage(section, param)));
        return results.every(isNotNullOrUndefined);
    }
    async persistToStorage(data, param, results) {
        for (let i = 0; i < data.sections.length; i++) {
            const section = data.sections[i];
            await this.cache.persistToStorage(section, param, results[i]);
        }
    }
    clear() {
        this.cache.clear();
    }
    async clearStorage() {
        await this.cache.clearStorage();
    }
    async clearOtherModStorage() {
        await this.cache.clearOtherModStorage();
    }
    get(key) {
        let geometry = this.cache.get(key);
        if (!geometry) {
            // Low = Culled (per-face cubes, more tris). High = Monotone (greedy mesh, fewer tris).
            // Prefer High on memory-constrained devices — Application soft-caps mobile to High.
            geometry = this.modelQuality === ModelQuality.Low
                ? new VxlGeometryCulledBuilder().build(key)
                : new VxlGeometryMonotoneBuilder().build(key);
            this.cache.set(key, geometry);
        }
        return geometry;
    }
}
