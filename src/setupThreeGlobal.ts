import * as THREE from 'three';
const bufferGeometryProto = THREE.BufferGeometry.prototype as THREE.BufferGeometry & {
    addAttribute?: (name: string, attribute: THREE.BufferAttribute) => THREE.BufferGeometry;
};
if (!bufferGeometryProto.addAttribute) {
    bufferGeometryProto.addAttribute = function addAttribute(this: THREE.BufferGeometry, name: string, attribute: THREE.BufferAttribute): THREE.BufferGeometry {
        this.setAttribute(name, attribute);
        return this;
    };
}
const bufferAttributeProto = THREE.BufferAttribute.prototype as THREE.BufferAttribute & {
    setDynamic?: (dynamic: boolean) => THREE.BufferAttribute;
    updateRange?: {
        offset: number;
        count: number;
    };
};
if (!bufferAttributeProto.setDynamic) {
    bufferAttributeProto.setDynamic = function setDynamic(this: THREE.BufferAttribute, dynamic: boolean): THREE.BufferAttribute {
        this.setUsage(dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
        return this;
    };
}
if (!Object.getOwnPropertyDescriptor(bufferAttributeProto, 'updateRange')) {
    Object.defineProperty(bufferAttributeProto, 'updateRange', {
        configurable: true,
        enumerable: false,
        get(this: THREE.BufferAttribute & {
            __legacyUpdateRange?: {
                offset: number;
                count: number;
            };
        }) {
            this.__legacyUpdateRange ??= { offset: 0, count: -1 };
            return this.__legacyUpdateRange;
        },
        set(this: THREE.BufferAttribute & {
            __legacyUpdateRange?: {
                offset: number;
                count: number;
            };
        }, value: {
            offset: number;
            count: number;
        }) {
            this.__legacyUpdateRange = value;
        },
    });
}
const originalComputeBoundingSphere = bufferGeometryProto.computeBoundingSphere;
if (originalComputeBoundingSphere) {
    bufferGeometryProto.computeBoundingSphere = function computeBoundingSphereSafe(this: THREE.BufferGeometry) {
        const position = this.attributes.position;
        if (position) {
            const array = position.array as ArrayLike<number>;
            for (let i = 0; i < array.length; i++) {
                if (!Number.isFinite(array[i])) {
                    if (!this.boundingSphere) {
                        this.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
                    } else {
                        this.boundingSphere.center.set(0, 0, 0);
                        this.boundingSphere.radius = 0;
                    }
                    return this.boundingSphere;
                }
            }
        }
        return originalComputeBoundingSphere.call(this);
    };
}
const legacyThree = Object.assign({}, THREE, {
    Math: {
        generateUUID: THREE.MathUtils.generateUUID,
    },
});
const globalWindow = window as Window & typeof globalThis & {
    THREE?: typeof legacyThree;
};
globalWindow.THREE = legacyThree;
export { THREE };
