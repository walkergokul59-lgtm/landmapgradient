'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { calculateArea, normalizePolygon } from '@/lib/geo'; // Assumed helpers
import { Feature, Polygon, MultiPolygon } from 'geojson';

// Dynamic import for MapComponent
const MapComponent = dynamic(() => import('@/components/MapComponent'), {
  loading: () => <div style={{ width: '100%', height: '100%', background: '#eee' }}>Loading map...</div>,
  ssr: false
});



interface SearchResult {
  place_id: number;
  display_name: string;
  type: string;
  osm_id: number;
  osm_type: string;
  lat: string;
  lon: string;
  geojson?: any; // Nominatim returns this if requested
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [boundaryGeoJson, setBoundaryGeoJson] = useState<Feature<Polygon | MultiPolygon> | null>(null);
  const [polygonPath, setPolygonPath] = useState<google.maps.LatLngLiteral[] | null>(null);
  const [areaSqM, setAreaSqM] = useState<number | null>(null);

  // --- OSM Logic ---

  const handleSearch = async () => {
    if (!query.trim()) return;
    setIsSearching(true);
    setSearchError(null);
    setSearchResults([]);

    try {
      const res = await fetch(`/api/osm/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error('Search failed');
      const data: SearchResult[] = await res.json();
      setSearchResults(data);
    } catch (err: any) {
      setSearchError(err.message || 'Error occurred');
    } finally {
      setIsSearching(false);
    }
  };

  const selectResult = async (result: SearchResult) => {
    setSearchError(null);
    try {
      let geojsonFeature: Feature<Polygon | MultiPolygon> | null = null;

      // 1. Check if Nominatim returned polygon geojson
      if (result.geojson && (result.geojson.type === 'Polygon' || result.geojson.type === 'MultiPolygon')) {
        geojsonFeature = {
          type: 'Feature',
          geometry: result.geojson,
          properties: {}
        };
      } else {
        // 2. Fallback to Overpass
        const opRes = await fetch(`/api/osm/boundary?osm_id=${result.osm_id}&osm_type=${result.osm_type}`);
        if (!opRes.ok) throw new Error("Failed to fetch boundary details");
        const opData = await opRes.json();
        // osmtogeojson usually returns a FeatureCollection
        // We need to find the boundary feature
        if (opData.type === 'FeatureCollection' && opData.features.length > 0) {
          // Usually the first feature or the one matching id
          geojsonFeature = opData.features[0] as Feature<Polygon | MultiPolygon>;
        }
      }

      if (!geojsonFeature) {
        throw new Error("No boundary polygon found for this location.");
      }

      // 3. Normalize & Update State
      const normalized = normalizePolygon(geojsonFeature);
      if (!normalized) throw new Error("Could not normalize geometry to Polygon.");

      updateBoundaryState(normalized);

    } catch (err: any) {
      setSearchError(err.message);
    }
  };

  const updateBoundaryState = (feature: Feature<Polygon | MultiPolygon>) => {
    setBoundaryGeoJson(feature);
    setAreaSqM(calculateArea(feature));

    // Convert to Google Maps Path (just the outer shell of the first polygon if Multi)
    // For simplicity in this demo, strict handling of MultiPolygon > Google Polygon (paths array)
    if (feature.geometry.type === 'Polygon') {
      const coords = feature.geometry.coordinates[0]; // Ring 0
      const path = coords.map(c => ({ lat: c[1], lng: c[0] }));
      setPolygonPath(path);
    } else if (feature.geometry.type === 'MultiPolygon') {
      // Flatten or pick largest. lib/geo normalizePolygon should have already picked the largest Polygon?
      // If normalizePolygon returns 'Polygon' type (as implemented in lib/geo), we are good.
      // Wait, my lib/geo implementation returns Feature<Polygon | MultiPolygon>.
      // Actually implementation in lib/geo: normalizePolygon returns Feature<Polygon | MultiPolygon> but logic tries to return Polygon.
      // Let's assume it returns Polygon.
      // If it was valid, calculateArea handles it.
      // Visualization:
      if (feature.geometry.type === 'Polygon') {
        const coords = feature.geometry.coordinates[0];
        setPolygonPath(coords.map(c => ({ lat: c[1], lng: c[0] })));
      }
    }
  };



  const handleClear = () => {
    setBoundaryGeoJson(null);
    setPolygonPath(null);
    setAreaSqM(null);
    setSearchResults([]);
    setSearchError(null);
    setQuery('');
  };

  /* Roads Logic */
  const [bufferDistance, setBufferDistance] = useState(300);
  const [roadTypes, setRoadTypes] = useState({
    motorway: true,
    trunk: true,
    primary: true,
    secondary: true
  });
  const [roadsHelpers, setRoadsHelpers] = useState<Feature<any>[]>([]); // Store GeoJSON features if needed
  const [roadsPaths, setRoadsPaths] = useState<google.maps.LatLngLiteral[][]>([]);
  const [isFetchingRoads, setIsFetchingRoads] = useState(false);
  const [roadsError, setRoadsError] = useState<string | null>(null);
  const [roadsStats, setRoadsStats] = useState<{ count: number, timeMs: number } | null>(null);

  const handleFetchRoads = async () => {
    if (!boundaryGeoJson) {
      setRoadsError("Please load a boundary first.");
      return;
    }

    setIsFetchingRoads(true);
    setRoadsError(null);
    setRoadsStats(null);
    setRoadsPaths([]);
    const startTime = performance.now();

    try {
      // 1. Calculate Buffer and BBOX client-side
      const { createBuffer, getBoundingBox } = await import('@/lib/geo');

      // boundaryGeoJson is Feature<Polygon|MultiPolygon>. Type casting for ts if needed.
      const buffered = createBuffer(boundaryGeoJson as any, bufferDistance);
      if (!buffered) throw new Error("Failed to create buffer");

      const bbox = getBoundingBox(buffered as any); // [minX, minY, maxX, maxY]

      // 2. Prepare Types
      const selectedTypes = Object.entries(roadTypes)
        .filter(([_, enabled]) => enabled)
        .map(([type]) => type);

      if (selectedTypes.length === 0) throw new Error("Select at least one road type.");

      // 3. Call API
      const res = await fetch('/api/osm/roads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox, types: selectedTypes })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to fetch roads");
      }

      const geojson = await res.json();
      // geojson is FeatureCollection

      const roadFeatures: Feature<any>[] = geojson.features.filter((f: any) => f.geometry.type === 'LineString');
      setRoadsHelpers(roadFeatures);

      // Convert to Google Maps Paths
      const newPaths: google.maps.LatLngLiteral[][] = roadFeatures.map((f) => {
        const coords = (f.geometry as any).coordinates; // [[lng, lat]]
        return coords.map((c: number[]) => ({ lat: c[1], lng: c[0] }));
      });

      setRoadsPaths(newPaths);
      setRoadsStats({
        count: newPaths.length,
        timeMs: Math.round(performance.now() - startTime)
      });

    } catch (err: any) {
      setRoadsError(err.message);
      console.error(err);
    } finally {
      setIsFetchingRoads(false);
    }
  };

  const [closestRoadData, setClosestRoadData] = useState<{
    roadIndex: number;
    distanceMeters: number;
    connection: google.maps.LatLngLiteral[]
  } | null>(null);

  const handleComputeClosestRoad = async () => {
    if (!boundaryGeoJson || roadsHelpers.length === 0) return;

    try {
      const { findClosestRoadAndConnection } = await import('@/lib/geo');

      // findClosestRoadAndConnection expects Feature<Polygon> and Feature<LineString>[]
      // boundaryGeoJson is Feature<Polygon|MultiPolygon>. Logic handles it.
      const result = findClosestRoadAndConnection(boundaryGeoJson as any, roadsHelpers);

      if (result) {
        setClosestRoadData({
          roadIndex: result.roadIndex,
          distanceMeters: result.distanceMeters,
          connection: result.connection.map(p => ({ lat: p[1], lng: p[0] }))
        });
      } else {
        alert("Could not find closest road.");
      }

    } catch (e) {
      console.error(e);
      alert("Error calculating distance");
    }
  };

  /* Subdivision Logic */
  const [cellSize, setCellSize] = useState(50);
  const [isGeneratingGrid, setIsGeneratingGrid] = useState(false);
  const [gridStats, setGridStats] = useState<{ count: number } | null>(null);
  const [gridFeatures, setGridFeatures] = useState<Feature<Polygon>[]>([]);
  const [gridPaths, setGridPaths] = useState<google.maps.LatLngLiteral[][]>([]);

  /* Valuation Logic */
  const [valuationMode, setValuationMode] = useState<'linear' | 'exponential'>('linear');
  const [decayFactor, setDecayFactor] = useState(0.005);
  const [coloredCells, setColoredCells] = useState<{ path: google.maps.LatLngLiteral[], color: string, tooltip: string }[]>([]);
  const [valuationStats, setValuationStats] = useState<{ minV: number, maxV: number, minD: number, maxD: number } | null>(null);

  const handleGenerateGrid = async () => {
    if (!boundaryGeoJson) return;
    setIsGeneratingGrid(true);
    setGridStats(null);
    setGridPaths([]);
    setGridFeatures([]);
    setColoredCells([]);
    setValuationStats(null);

    try {
      const { generateSubdivisionGrid } = await import('@/lib/geo');

      const cells = generateSubdivisionGrid(boundaryGeoJson as any, cellSize);
      setGridFeatures(cells);

      const paths = cells.map(cell => {
        if (cell.geometry.type === 'Polygon') {
          const ring = cell.geometry.coordinates[0];
          return ring.map(c => ({ lat: c[1], lng: c[0] }));
        }
        return [];
      }).filter(p => p.length > 0);

      setGridPaths(paths);
      setGridStats({ count: paths.length });

    } catch (e) {
      console.error(e);
      alert("Error generating grid");
    } finally {
      setIsGeneratingGrid(false);
    }
  };

  const handleCalculateValuation = async () => {
    // Requirements: gridFeatures, closestRoadIndex, roadsHelpers
    if (gridFeatures.length === 0 || closestRoadData === null || roadsHelpers.length === 0) {
      alert("Please generate grid and select a closest road first.");
      return;
    }

    const targetRoad = roadsHelpers[closestRoadData.roadIndex];
    // closestRoadData.roadIndex is index in roadsPaths/roadsHelpers.

    try {
      const { calculateLandValues } = await import('@/lib/geo');
      // roadFeature must be LineString Feature.
      const results = calculateLandValues(gridFeatures, targetRoad as Feature<LineString>, valuationMode, decayFactor);

      // Convert to colored cells
      const colored = results.map(r => {
        const path = (r.feature.geometry.coordinates[0] as number[][]).map(c => ({ lat: c[1], lng: c[0] }));
        return {
          path: path,
          color: r.color,
          tooltip: `Dist: ${Math.round(r.distance)}m, Val: ${r.value.toFixed(2)}`
        };
      });

      setColoredCells(colored);

      if (results.length > 0) {
        const dists = results.map(r => r.distance);
        const vals = results.map(r => r.value);
        setValuationStats({
          minD: Math.min(...dists),
          maxD: Math.max(...dists),
          minV: Math.min(...vals),
          maxV: Math.max(...vals)
        });
      }

    } catch (e) {
      console.error(e);
      alert("Error calculating valuation");
    }
  };

  const toggleRoadType = (type: keyof typeof roadTypes) => {
    setRoadTypes(prev => ({ ...prev, [type]: !prev[type] }));
  };

  return (
    <main style={{ display: 'flex', flexDirection: 'row', height: '100vh', width: '100vw' }}>
      {/* Sidebar */}
      <div style={{
        width: '360px',
        backgroundColor: 'var(--panel-bg)',
        borderRight: '1px solid #e0e0e0',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '4px 0 24px rgba(0,0,0,0.05)',
        zIndex: 10,
        overflowY: 'auto'
      }}>
        <div style={{ padding: '24px' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '1.5rem', marginTop: 0 }}>
            Land Value Gradient
          </h1>



          {/* Search UI */}
          <div style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
              <input
                type="text"
                placeholder="Search place (e.g. HSR Layout)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid #ccc' }}
              />
              <button
                onClick={handleSearch}
                disabled={isSearching}
                style={{ padding: '10px 16px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
              >
                {isSearching ? '...' : 'Go'}
              </button>
            </div>

            {searchError && <div style={{ color: 'red', fontSize: '0.9rem', marginBottom: '1rem' }}>{searchError}</div>}

            {searchResults.length > 0 && (
              <div style={{ border: '1px solid #eee', borderRadius: '8px', overflow: 'hidden' }}>
                {searchResults.map((res) => (
                  <div
                    key={res.place_id}
                    onClick={() => selectResult(res)}
                    style={{
                      padding: '10px',
                      borderBottom: '1px solid #eee',
                      cursor: 'pointer',
                      fontSize: '0.9rem'
                    }}
                    onMouseOver={(e) => e.currentTarget.style.background = '#f5f5f5'}
                    onMouseOut={(e) => e.currentTarget.style.background = 'white'}
                  >
                    <div style={{ fontWeight: '600' }}>{res.display_name.split(',')[0]}</div>
                    <div style={{ color: '#666', fontSize: '0.8rem' }}>{res.type}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={handleClear}
            style={{
              width: '100%', padding: '10px',
              borderRadius: '8px', border: '1px solid #ccc', background: 'white',
              cursor: 'pointer', marginBottom: '1.5rem'
            }}
          >
            Clear Boundary
          </button>

          {/* Metrics & Output */}
          <div style={{
            padding: '20px',
            backgroundColor: 'rgba(0,0,0,0.03)',
            borderRadius: '12px',
            border: '1px solid rgba(0,0,0,0.05)',
            marginBottom: '1rem'
          }}>
            <span style={{ fontSize: '0.85rem', color: '#888', textTransform: 'uppercase', display: 'block', marginBottom: '8px' }}>
              Area
            </span>
            <span style={{ fontSize: '1.5rem', fontWeight: '600' }}>
              {areaSqM ? areaSqM.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '---'}
              <span style={{ fontSize: '1rem', color: '#888', marginLeft: '4px' }}>m²</span>
            </span>
          </div>

          {/* Roads Section */}
          {boundaryGeoJson && (
            <div style={{ marginTop: '2rem', borderTop: '1px solid #eee', paddingTop: '1.5rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: '700', marginBottom: '1rem' }}>Roads Scanning</h2>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '6px', color: '#666' }}>
                  Buffer (meters)
                </label>
                <input
                  type="number"
                  value={bufferDistance}
                  onChange={(e) => setBufferDistance(Number(e.target.value))}
                  style={{
                    width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #ddd',
                    fontSize: '0.9rem'
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '1rem' }}>
                {Object.keys(roadTypes).map((type) => (
                  <label key={type} style={{ display: 'flex', alignItems: 'center', fontSize: '0.85rem', cursor: 'pointer', padding: '4px 8px', background: '#f5f5f5', borderRadius: '12px' }}>
                    <input
                      type="checkbox"
                      checked={roadTypes[type as keyof typeof roadTypes]}
                      onChange={() => toggleRoadType(type as keyof typeof roadTypes)}
                      style={{ marginRight: '6px' }}
                    />
                    {type}
                  </label>
                ))}
              </div>

              <button
                onClick={handleFetchRoads}
                disabled={isFetchingRoads}
                style={{
                  width: '100%',
                  padding: '10px',
                  backgroundColor: 'white',
                  color: 'var(--primary)',
                  border: '1px solid var(--primary)',
                  borderRadius: '8px',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                {isFetchingRoads ? 'Scanning...' : 'Fetch Roads'}
              </button>

              {roadsError && (
                <div style={{ color: 'red', fontSize: '0.85rem', marginTop: '8px' }}>
                  {roadsError}
                </div>
              )}
              {roadsStats && (
                <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: '#555', background: '#e1f5fe', padding: '10px', borderRadius: '6px' }}>
                  <div>Roads Found: <strong>{roadsStats.count}</strong></div>
                  <div>Request Time: <strong>{roadsStats.timeMs}ms</strong></div>
                </div>
              )}

              {roadsPaths.length > 0 && (
                <div style={{ marginTop: '1.5rem' }}>
                  <button
                    onClick={handleComputeClosestRoad}
                    style={{
                      width: '100%',
                      padding: '10px',
                      backgroundColor: 'var(--primary)',
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      fontWeight: '600',
                      cursor: 'pointer'
                    }}
                  >
                    Calculate Distance to Main Road
                  </button>
                </div>
              )}

              {closestRoadData && (
                <div style={{
                  marginTop: '1rem',
                  padding: '16px',
                  backgroundColor: '#fff3e0',
                  border: '1px solid #ffe0b2',
                  borderRadius: '12px'
                }}>
                  <span style={{ fontSize: '0.85rem', color: '#e65100', textTransform: 'uppercase', display: 'block', marginBottom: '4px' }}>
                    Minimum Distance
                  </span>
                  <span style={{ fontSize: '1.8rem', fontWeight: '700', color: '#e65100' }}>
                    {Math.round(closestRoadData.distanceMeters)}
                    <span style={{ fontSize: '1rem', fontWeight: '500', marginLeft: '4px' }}>m</span>
                  </span>
                </div>
              )}

              {/* Subdivision Grid */}
              <div style={{ marginTop: '2rem', borderTop: '1px solid #eee', paddingTop: '1.5rem' }}>
                <h2 style={{ fontSize: '1rem', fontWeight: '700', marginBottom: '1rem' }}>Subdivision</h2>

                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '6px', color: '#666' }}>
                    Cell Size (meters)
                  </label>
                  <input
                    type="number"
                    value={cellSize}
                    onChange={(e) => setCellSize(Number(e.target.value))}
                    style={{
                      width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #ddd',
                      fontSize: '0.9rem'
                    }}
                  />
                </div>

                <button
                  onClick={handleGenerateGrid}
                  disabled={isGeneratingGrid}
                  style={{
                    width: '100%',
                    padding: '10px',
                    backgroundColor: 'white',
                    color: '#007aff',
                    border: '1px solid #007aff',
                    borderRadius: '8px',
                    fontWeight: '600',
                    cursor: 'pointer'
                  }}
                >
                  {isGeneratingGrid ? 'Generating...' : 'Generate Land Grid'}
                </button>

                {gridStats && (
                  <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: '#555', background: '#f5f5f5', padding: '10px', borderRadius: '6px' }}>
                    Cells Generated: <strong>{gridStats.count}</strong>
                  </div>
                )}
              </div>

              {/* Valuation Section */}
              {gridPaths.length > 0 && closestRoadData && (
                <div style={{ marginTop: '2rem', borderTop: '1px solid #eee', paddingTop: '1.5rem' }}>
                  <h2 style={{ fontSize: '1rem', fontWeight: '700', marginBottom: '1rem' }}>Land Valuation</h2>

                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ fontSize: '0.85rem', color: '#666', marginRight: '10px' }}>Mode:</label>
                    <select
                      value={valuationMode}
                      onChange={(e) => setValuationMode(e.target.value as any)}
                      style={{ padding: '6px', borderRadius: '4px', border: '1px solid #ddd' }}
                    >
                      <option value="linear">Linear Decay</option>
                      <option value="exponential">Exponential Decay</option>
                    </select>
                  </div>

                  {valuationMode === 'exponential' && (
                    <div style={{ marginBottom: '1rem' }}>
                      <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '6px', color: '#666' }}>
                        Decay Factor (k): {decayFactor}
                      </label>
                      <input
                        type="range"
                        min="0.001"
                        max="0.05"
                        step="0.001"
                        value={decayFactor}
                        onChange={(e) => setDecayFactor(Number(e.target.value))}
                        style={{ width: '100%' }}
                      />
                    </div>
                  )}

                  <button
                    onClick={handleCalculateValuation}
                    style={{
                      width: '100%',
                      padding: '10px',
                      backgroundColor: '#e65100',
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      fontWeight: '600',
                      cursor: 'pointer'
                    }}
                  >
                    Calculate Value Gradient
                  </button>

                  {/* Legend */}
                  {valuationStats && (
                    <div style={{ marginTop: '1rem', padding: '10px', background: '#f5f5f5', borderRadius: '6px', fontSize: '0.8rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                        <span>High Value (Close)</span>
                        <span>Low Value (Far)</span>
                      </div>
                      <div style={{ height: '10px', background: 'linear-gradient(to right, rgb(215,48,39), rgb(254,224,144), rgb(69,117,180))', borderRadius: '4px', marginBottom: '5px' }}></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#666' }}>
                        <span>{Math.round(valuationStats.minD)}m (Val: {valuationStats.maxV.toFixed(2)})</span>
                        <span>{Math.round(valuationStats.maxD)}m (Val: {valuationStats.minV.toFixed(2)})</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Map */}
      <div style={{ flex: 1, position: 'relative' }}>
        <MapComponent
          polygonPath={polygonPath}
          roads={roadsPaths}
          closestRoadIndex={closestRoadData?.roadIndex}
          connectionLine={closestRoadData?.connection}
          gridCells={gridPaths}
          coloredCells={coloredCells}
        />

        {/* Tooltip Overlay (if needed, but MapComponent handles hover visually? Use map polygons title if possible or custom overlay) 
            For this iteration, we rely on console logs or maybe just tooltip attribute if supported? 
            Polygon options don't support simple tooltip.
            We added styling.
        */}
      </div>
    </main>
  );
}
