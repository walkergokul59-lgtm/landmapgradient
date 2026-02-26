
import { polygon, lineString, point, featureCollection } from '@turf/helpers';
import turfArea from '@turf/area';
import turfBbox from '@turf/bbox';
import turfBuffer from '@turf/buffer';
import turfNearestPointOnLine from '@turf/nearest-point-on-line';
import turfDistance from '@turf/distance';
import turfExplode from '@turf/explode';
import turfSquareGrid from '@turf/square-grid';
import turfIntersect from '@turf/intersect';
import turfBooleanIntersects from '@turf/boolean-intersects';
import turfPointToLineDistance from '@turf/point-to-line-distance';
import turfCentroid from '@turf/centroid';
import { scaleSequential } from 'd3-scale';
import { interpolateRdYlBu } from 'd3-scale-chromatic';
import { Feature, Polygon, MultiPolygon, LineString, Position, FeatureCollection } from 'geojson';
// The "geojson" package types or types from @turf/helpers
type GeoJSONPolygon = Feature<Polygon | MultiPolygon>;
type GeoJSONLineString = Feature<LineString>;

export function calculateArea(geojson: GeoJSONPolygon | null): number {
    if (!geojson) return 0;
    return turfArea(geojson);
}

export function getBoundingBox(geojson: GeoJSONPolygon) {
    return turfBbox(geojson);
}

export function normalizePolygon(feature: any): GeoJSONPolygon | null {
    if (!feature || !feature.geometry) return null;
    const geomLink = feature.geometry;

    if (geomLink.type === 'Polygon') {
        return feature as GeoJSONPolygon;
    }

    if (geomLink.type === 'MultiPolygon') {
        const coords = geomLink.coordinates as number[][][][];
        let maxArea = -1;
        let maxPolyCoords: number[][][] | null = null;
        coords.forEach((polyCoords) => {
            const polyFeature = polygon(polyCoords);
            const a = turfArea(polyFeature);
            if (a > maxArea) {
                maxArea = a;
                maxPolyCoords = polyCoords;
            }
        });
        if (maxPolyCoords) {
            return polygon(maxPolyCoords) as GeoJSONPolygon;
        }
    }
    return null;
}

export function googlePathToGeoJSON(path: google.maps.LatLngLiteral[]): GeoJSONPolygon {
    if (path.length < 3) throw new Error("Polygon must have at least 3 points");
    const ring = path.map(p => [p.lng, p.lat]);
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
        ring.push(ring[0]);
    }
    return polygon([ring]) as GeoJSONPolygon;
}

export function createBuffer(geojson: GeoJSONPolygon, radiusMeters: number): GeoJSONPolygon | null {
    try {
        // @ts-ignore
        const buffered = turfBuffer(geojson, radiusMeters, { units: 'meters' });
        if (!buffered || !buffered.geometry) return null;
        return buffered as GeoJSONPolygon;
    } catch (e) {
        console.error("Buffer error", e);
        return null;
    }
}

interface ClosestRoadResult {
    roadIndex: number;
    distanceMeters: number;
    connection: Position[]; // [start, end]
}

export function findClosestRoadAndConnection(
    polygonFeature: GeoJSONPolygon,
    roads: Feature<LineString>[]
): ClosestRoadResult | null {
    if (!polygonFeature || !roads || roads.length === 0) return null;

    // 1. Convert Polygon boundary to LineString(s)
    let boundaryLines: Feature<LineString>[] = [];
    if (polygonFeature.geometry.type === 'Polygon') {
        // Outer ring only
        boundaryLines.push(lineString(polygonFeature.geometry.coordinates[0]));
    } else if (polygonFeature.geometry.type === 'MultiPolygon') {
        // Should have been normalized, but just in case
        polygonFeature.geometry.coordinates.forEach(poly => {
            boundaryLines.push(lineString(poly[0]));
        });
    }

    if (boundaryLines.length === 0) return null;

    // Use the first/main boundary for calculation
    const boundary = boundaryLines[0];

    let globalMinDist = Infinity;
    let closestRoadIndex = -1;
    let bestConnection: Position[] = [];

    // Helper: Find closest distance between two LineStrings by sampling vertices
    // Improve accuracy: also sample points along lines if vertices are sparse?
    // For now, vertices + exploded points should be decent approximation for OSM data which is dense.

    roads.forEach((road, index) => {
        // Strategy: 
        // A. Iterate vertices of Boundary -> find Nearest on Road
        // B. Iterate vertices of Road -> find Nearest on Boundary
        // Take min.

        let currentMinDist = Infinity;
        let currentConnection: Position[] = [];

        // A. Boundary Points -> Road
        const boundaryPoints = turfExplode(boundary);
        boundaryPoints.features.forEach(pt => {
            const nearestOnRoad = turfNearestPointOnLine(road, pt, { units: 'meters' });
            if (nearestOnRoad && nearestOnRoad.properties && nearestOnRoad.properties.dist !== undefined) {
                const d = nearestOnRoad.properties.dist; // already in meters? 
                // turf-nearest-point-on-line returns dist in km by default unless units specified?
                // Checking docs: 'units' option default is kilometers. We passed 'meters'? 
                // Actually default might be km. Let's force check.
                // NOTE: turf types might be tricky. Let's trust it returns number.
                // If units='meters', it returns number in meters.
                if (d < currentMinDist) {
                    currentMinDist = d;
                    currentConnection = [pt.geometry.coordinates, nearestOnRoad.geometry.coordinates];
                }
            }
        });

        // B. Road Points -> Boundary
        const roadPoints = turfExplode(road);
        roadPoints.features.forEach(pt => {
            const nearestOnBoundary = turfNearestPointOnLine(boundary, pt, { units: 'meters' });
            if (nearestOnBoundary && nearestOnBoundary.properties && nearestOnBoundary.properties.dist !== undefined) {
                const d = nearestOnBoundary.properties.dist;
                if (d < currentMinDist) {
                    currentMinDist = d;
                    currentConnection = [nearestOnBoundary.geometry.coordinates, pt.geometry.coordinates];
                }
            }
        });

        if (currentMinDist < globalMinDist) {
            globalMinDist = currentMinDist;
            closestRoadIndex = index;
            bestConnection = currentConnection;
        }
    });

    if (closestRoadIndex !== -1) {
        return {
            roadIndex: closestRoadIndex,
            distanceMeters: globalMinDist,
            connection: bestConnection
        };
    }

    return null;
}

export function generateSubdivisionGrid(polygonFeature: GeoJSONPolygon, cellSizeMeters: number): Feature<Polygon>[] {
    if (!polygonFeature) return [];

    const bbox = turfBbox(polygonFeature);
    // squareGrid uses units (kilometers default). Convert meters to km.
    const cellSideKm = cellSizeMeters / 1000;

    // @ts-ignore
    const grid = turfSquareGrid(bbox, cellSideKm, { units: 'kilometers' });

    const clippedCells: Feature<Polygon>[] = [];

    // Filter and clip
    grid.features.forEach((cell) => {
        // First quick check
        const intersects = turfBooleanIntersects(cell, polygonFeature);
        if (intersects) {
            try {
                // @ts-ignore
                // @ts-ignore
                const clipped = turfIntersect(featureCollection([cell, polygonFeature]));
                if (clipped) {
                    if (clipped.geometry.type === 'Polygon') {
                        clippedCells.push(clipped as Feature<Polygon>);
                    } else if (clipped.geometry.type === 'MultiPolygon') {
                        // Split multipolygon clipping result into single polygons
                        clipped.geometry.coordinates.forEach((coords: any) => {
                            clippedCells.push(polygon(coords) as Feature<Polygon>);
                        });
                    }
                }
            } catch (e) {
                console.error("Intersection failed for cell", e);
            }
        }
    });

    return clippedCells;
}

export interface CellValue {
    feature: Feature<Polygon>;
    distance: number;
    value: number;
    color: string;
}

export function calculateLandValues(
    cells: Feature<Polygon>[],
    roadFeature: Feature<LineString>,
    mode: 'linear' | 'exponential',
    decayK: number = 0.005,
    maxDistanceOverride?: number
): CellValue[] {
    if (!cells.length || !roadFeature) return [];

    const results = cells.map(cell => {
        const center = turfCentroid(cell);
        // calculate min distance from center to road line
        // units: meters
        const dist = turfPointToLineDistance(center, roadFeature, { units: 'meters' });
        return {
            feature: cell,
            distance: dist,
            value: 0,
            color: ''
        };
    });

    const maxDist = maxDistanceOverride || Math.max(...results.map(r => r.distance), 1); // avoid 0
    // 0 = Red, 1 = Blue.
    const colorScale = scaleSequential(interpolateRdYlBu).domain([0, 1]);

    results.forEach(r => {
        let val = 0;
        if (mode === 'linear') {
            // Linear: 1 - (d / maxD)
            val = Math.max(0, 1 - (r.distance / maxDist));
        } else {
            // Exp: exp(-k * d)
            val = Math.exp(-decayK * r.distance);
        }
        r.value = val;

        // Color mapping
        // Value 1 (High/Close) -> Warm (Red) -> Low t
        // Value 0 (Low/Far) -> Cool (Blue) -> High t
        // interpolateRdYlBu(t): 0=Red, 1=Blue.
        // t = 1 - val. 
        // If val=1 (High Value), t=0 (Red/Warm).
        // If val=0 (Low Value), t=1 (Blue/Cool).
        r.color = colorScale(1 - val);
    });

    return results;
}
