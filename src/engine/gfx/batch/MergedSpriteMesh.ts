import * as THREE from 'three';
import * as arrayUtils from '../../../util/array';
import { PaletteBasicMaterial } from '../material/PaletteBasicMaterial';
const tempVector3 = new THREE.Vector3();
const tempVector4 = new THREE.Vector4();
export class MergedSpriteMesh extends THREE.Mesh {
    public maxInstances: number;
    public verticesPerItem: number;
    public indicesPerItem: number | undefined;
    static createMergedGeometry(sourceGeometry: THREE.BufferGeometry, maxInstances: number, material: THREE.Material): THREE.BufferGeometry {
        const mergedGeometry = new THREE.BufferGeometry();
        for (const attributeName of Object.keys(sourceGeometry.attributes)) {
            const sourceAttribute = sourceGeometry.getAttribute(attributeName);
            const ArrayConstructor = sourceAttribute.array.constructor as any;
            const mergedArray = new ArrayConstructor(maxInstances * sourceAttribute.array.length);
            mergedGeometry.setAttribute(attributeName, new THREE.BufferAttribute(mergedArray, sourceAttribute.itemSize, sourceAttribute.normalized));
        }
        const vertexCount = sourceGeometry.getAttribute('position').count;
        if (material instanceof PaletteBasicMaterial) {
            mergedGeometry.setAttribute('vertexColorMult', new THREE.BufferAttribute(new Float32Array(vertexCount * maxInstances * 4), 4));
        }
        if ((material as any).palette) {
            mergedGeometry.setAttribute('vertexPaletteOffset', new THREE.BufferAttribute(new Float32Array(vertexCount * maxInstances), 1));
        }
        for (const attribute of Object.values(mergedGeometry.attributes)) {
            (attribute as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
        }
        if (sourceGeometry.index) {
            mergedGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(maxInstances * sourceGeometry.index.array.length), 1));
            for (let i = 0; i < maxInstances; i++) {
                const vertexOffset = i * vertexCount;
                const indexArray = mergedGeometry.index!.array as Uint32Array;
                const sourceIndexArray = sourceGeometry.index.array;
                indexArray.set(Uint32Array.from(sourceIndexArray, (index: number) => index + vertexOffset), i * sourceIndexArray.length);
            }
        }
        return mergedGeometry;
    }
    constructor(sourceGeometry: THREE.BufferGeometry, material: THREE.Material, maxInstances: number) {
        super(MergedSpriteMesh.createMergedGeometry(sourceGeometry, maxInstances, material));
        this.maxInstances = maxInstances;
        this.material = this.decorateMaterial(material.clone());
        this.verticesPerItem = sourceGeometry.getAttribute('position').count;
        this.indicesPerItem = sourceGeometry.index?.count;
        this.frustumCulled = false;
    }
    private decorateMaterial(material: THREE.Material): THREE.Material {
        const mat = material as any;
        if (!mat.defines) {
            mat.defines = {};
        }
        if (mat.palette) {
            mat.defines.VERTEX_PALETTE_OFFSET = '';
        }
        if (material instanceof PaletteBasicMaterial) {
            (mat as any).useVertexColorMult = true;
        }
        return material;
    }
    public updateFromMeshes(meshes: any[]): void {
        const attributes = this.geometry.attributes;
        const positionAttr = attributes.position as THREE.BufferAttribute;
        const uvAttr = attributes.uv as THREE.BufferAttribute;
        const colorMultAttr = attributes.vertexColorMult as THREE.BufferAttribute;
        const paletteOffsetAttr = attributes.vertexPaletteOffset as THREE.BufferAttribute;
        const validMeshes: any[] = [];
        for (const mesh of meshes) {
            mesh.updateMatrixWorld(true);
            tempVector3.setFromMatrixPosition(mesh.matrixWorld);
            if (MergedSpriteMesh.isFiniteVector3(tempVector3)) {
                validMeshes.push(mesh);
            }
        }
        const meshCount = validMeshes.length;
        if (meshCount > this.maxInstances) {
            throw new RangeError('Exceeded maximum number of instances');
        }
        for (let i = 0; i < meshCount; i++) {
            const vertexOffset = i * this.verticesPerItem;
            const mesh = validMeshes[i];
            this.setGeometryAt(vertexOffset, mesh.geometry, tempVector3.setFromMatrixPosition(mesh.matrixWorld), positionAttr, uvAttr);
            const extraLight = mesh.getExtraLight();
            if (colorMultAttr) {
                this.setColorMultAt(vertexOffset, tempVector4.set(1 + extraLight.x, 1 + extraLight.y, 1 + extraLight.z, mesh.getOpacity()), colorMultAttr);
            }
            if (paletteOffsetAttr) {
                this.setPaletteIndexAt(vertexOffset, mesh.getPaletteIndex(), paletteOffsetAttr);
            }
        }
        for (let i = meshCount; i < this.maxInstances; i++) {
            this.clearInstanceGeometryAt(i * this.verticesPerItem, positionAttr);
        }
        this.geometry.setDrawRange(0, meshCount * (this.geometry.index ? this.indicesPerItem! : this.verticesPerItem));
        for (const attribute of Object.values(attributes)) {
            if ((attribute as any).usage === THREE.DynamicDrawUsage) {
                const bufferAttr = attribute as THREE.BufferAttribute;
                if (bufferAttr.updateRanges && bufferAttr.updateRanges.length > 0) {
                    bufferAttr.updateRanges[0].count =
                        meshCount < this.maxInstances
                            ? meshCount * this.verticesPerItem * bufferAttr.itemSize
                            : -1;
                }
            }
        }
        this.refreshBoundingSphere(meshCount, positionAttr);
    }
    private static isFiniteVector3(v: THREE.Vector3): boolean {
        return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    }
    private clearInstanceGeometryAt(vertexOffset: number, positionAttr: THREE.BufferAttribute): void {
        const targetPositions = positionAttr.array as Float32Array;
        for (let i = 0; i < this.verticesPerItem; i++) {
            const targetIndex = 3 * (vertexOffset + i);
            if (targetPositions[targetIndex] !== 0 ||
                targetPositions[targetIndex + 1] !== 0 ||
                targetPositions[targetIndex + 2] !== 0) {
                targetPositions[targetIndex] = 0;
                targetPositions[targetIndex + 1] = 0;
                targetPositions[targetIndex + 2] = 0;
                positionAttr.needsUpdate = true;
            }
        }
    }
    /** Avoid THREE recomputing a bounding sphere over stale / cleared instance slots. */
    private refreshBoundingSphere(meshCount: number, positionAttr: THREE.BufferAttribute): void {
        if (meshCount === 0) {
            if (!this.geometry.boundingSphere) {
                this.geometry.boundingSphere = new THREE.Sphere();
            }
            this.geometry.boundingSphere.center.set(0, 0, 0);
            this.geometry.boundingSphere.radius = 0;
            return;
        }
        const targetPositions = positionAttr.array as Float32Array;
        const vertexFloats = meshCount * this.verticesPerItem * 3;
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;
        for (let i = 0; i < vertexFloats; i += 3) {
            const x = targetPositions[i];
            const y = targetPositions[i + 1];
            const z = targetPositions[i + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                continue;
            }
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            maxZ = Math.max(maxZ, z);
        }
        if (!Number.isFinite(minX)) {
            if (!this.geometry.boundingSphere) {
                this.geometry.boundingSphere = new THREE.Sphere();
            }
            this.geometry.boundingSphere.center.set(0, 0, 0);
            this.geometry.boundingSphere.radius = 0;
            return;
        }
        if (!this.geometry.boundingSphere) {
            this.geometry.boundingSphere = new THREE.Sphere();
        }
        this.geometry.boundingSphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        const dx = maxX - minX;
        const dy = maxY - minY;
        const dz = maxZ - minZ;
        this.geometry.boundingSphere.radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
    }
    private setGeometryAt(vertexOffset: number, sourceGeometry: THREE.BufferGeometry, worldPosition: THREE.Vector3, positionAttr: THREE.BufferAttribute, uvAttr: THREE.BufferAttribute): void {
        if (!MergedSpriteMesh.isFiniteVector3(worldPosition)) {
            return;
        }
        const sourceAttributes = sourceGeometry.attributes;
        const sourcePositions = sourceAttributes.position.array as Float32Array;
        const targetPositions = positionAttr.array as Float32Array;
        for (let i = 0; i < this.verticesPerItem; i++) {
            const targetIndex = 3 * (vertexOffset + i);
            const sourceIndex = 3 * i;
            const x = Math.fround(sourcePositions[sourceIndex] + Math.fround(worldPosition.x));
            const y = Math.fround(sourcePositions[sourceIndex + 1] + Math.fround(worldPosition.y));
            const z = Math.fround(sourcePositions[sourceIndex + 2] + Math.fround(worldPosition.z));
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                continue;
            }
            if (x !== targetPositions[targetIndex] ||
                y !== targetPositions[targetIndex + 1] ||
                z !== targetPositions[targetIndex + 2]) {
                targetPositions[targetIndex] = x;
                targetPositions[targetIndex + 1] = y;
                targetPositions[targetIndex + 2] = z;
                positionAttr.needsUpdate = true;
            }
        }
        const targetUVs = uvAttr.array as Float32Array;
        const sourceUVs = sourceAttributes.uv.array as Float32Array;
        const uvStartIndex = 2 * vertexOffset;
        if (!arrayUtils.equals(Array.from(sourceUVs), Array.from(targetUVs.subarray(uvStartIndex, uvStartIndex + sourceUVs.length)))) {
            targetUVs.set(sourceUVs, uvStartIndex);
            uvAttr.needsUpdate = true;
        }
    }
    private setColorMultAt(vertexOffset: number, colorMult: THREE.Vector4, colorMultAttr: THREE.BufferAttribute): void {
        if (colorMultAttr.getX(vertexOffset) !== colorMult.x ||
            colorMultAttr.getY(vertexOffset) !== colorMult.y ||
            colorMultAttr.getZ(vertexOffset) !== colorMult.z ||
            colorMultAttr.getW(vertexOffset) !== colorMult.w) {
            colorMultAttr.needsUpdate = true;
            for (let i = 0; i < this.verticesPerItem; i++) {
                colorMultAttr.setXYZW(vertexOffset + i, colorMult.x, colorMult.y, colorMult.z, colorMult.w);
            }
        }
    }
    private setPaletteIndexAt(vertexOffset: number, paletteIndex: number, paletteOffsetAttr: THREE.BufferAttribute): void {
        if (paletteOffsetAttr.getX(vertexOffset) !== paletteIndex) {
            paletteOffsetAttr.needsUpdate = true;
            for (let i = 0; i < this.verticesPerItem; i++) {
                paletteOffsetAttr.setX(vertexOffset + i, paletteIndex);
            }
        }
    }
    public dispose(): void {
        this.geometry.dispose();
        (this.material as THREE.Material).dispose();
    }
}
