'use client';

import React, { useCallback, useState, useEffect } from 'react';
import { GoogleMap, useJsApiLoader, Polygon, Polyline } from '@react-google-maps/api';

const containerStyle = {
  width: '100%',
  height: '100%'
};

const defaultCenter = {
  lat: 40.7580, // Midtown NYC
  lng: -73.9855
};

// Define libraries array outside component to prevent re-renders
const LIBRARIES: ("places" | "geometry" | "visualization")[] = [];

// Define map options
const mapOptions = {
  disableDefaultUI: false,
  zoomControl: true,
  mapTypeControl: false,
  streetViewControl: false,
};

interface MapComponentProps {
  polygonPath: google.maps.LatLngLiteral[] | null;
  roads?: google.maps.LatLngLiteral[][];
  closestRoadIndex?: number | null;
  connectionLine?: google.maps.LatLngLiteral[] | null;
  gridCells?: google.maps.LatLngLiteral[][];
  coloredCells?: { path: google.maps.LatLngLiteral[], color: string, tooltip: string }[];
}

function MapComponent({
  polygonPath,
  roads,
  closestRoadIndex,
  connectionLine,
  gridCells,
  coloredCells
}: MapComponentProps) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES
  });

  const [map, setMap] = useState<google.maps.Map | null>(null);

  const onLoad = useCallback((map: google.maps.Map) => {
    setMap(map);
  }, []);

  const onUnmount = useCallback((map: google.maps.Map) => {
    setMap(null);
  }, []);

  // Effect to fit bounds when polygonPath changes
  useEffect(() => {
    if (map && polygonPath) {
      if (polygonPath.length > 0) {
        const bounds = new window.google.maps.LatLngBounds();
        polygonPath.forEach(coord => bounds.extend(coord));
        map.fitBounds(bounds);
      }
    }
  }, [map, polygonPath]);



  if (loadError) {
    return <div style={{ padding: '20px', color: 'red' }}>Error loading Google Maps. Please check your API key.</div>;
  }

  if (!isLoaded) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#eee' }}>Loading Map...</div>;
  }

  return (
    <GoogleMap
      mapContainerStyle={containerStyle}
      center={defaultCenter}
      zoom={12}
      onLoad={onLoad}
      onUnmount={onUnmount}
      options={mapOptions}
    >


      {/* Render Roads */}
      {roads && roads.map((roadPath, index) => {
        const isSelected = closestRoadIndex === index;
        return (
          <Polyline
            key={`road-${index}`}
            path={roadPath}
            options={{
              strokeColor: isSelected ? '#FF3D00' : '#FF6F00',
              strokeOpacity: isSelected ? 1.0 : 0.6,
              strokeWeight: isSelected ? 6 : 2,
              zIndex: isSelected ? 10 : 2,
              geodesic: true
            }}
          />
        );
      })}

      {/* Render Connection Line */}
      {connectionLine && (
        <Polyline
          path={connectionLine}
          options={{
            strokeColor: '#000000',
            strokeOpacity: 0.8,
            strokeWeight: 2,
            zIndex: 15,
            icons: [{
              icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 2 },
              offset: '0',
              repeat: '10px'
            }]
          }}
        />
      )}

      {/* Render Grid Cells (Colored or Plain) */}
      {coloredCells && coloredCells.length > 0 ? (
        coloredCells.map((cell, index) => (
          <Polygon
            key={`cell-colored-${index}`}
            paths={cell.path}
            options={{
              fillColor: cell.color,
              fillOpacity: 0.6,
              strokeColor: "#ffffff",
              strokeOpacity: 0.3,
              strokeWeight: 1,
              clickable: true // Enable for hover
            }}
            onMouseOver={() => {
              // console.log(cell.tooltip); // For now just log or we need state for UI
            }}
          />
        ))
      ) : (
        gridCells && gridCells.map((cellPath, index) => (
          <Polygon
            key={`cell-${index}`}
            paths={cellPath}
            options={{
              fillColor: "#EEEEEE",
              fillOpacity: 0.4,
              strokeColor: "#888888",
              strokeOpacity: 0.5,
              strokeWeight: 1,
              clickable: false
            }}
          />
        ))
      )}

      {/* Render the Boundary Polygon */}
      {polygonPath && polygonPath.length > 0 && (
        <Polygon
          paths={polygonPath}
          options={{
            fillColor: "#007aff",
            fillOpacity: 0.3,
            strokeColor: "#007aff",
            strokeOpacity: 0.8,
            strokeWeight: 2,
          }}
        />
      )}
    </GoogleMap>
  );
}

export default React.memo(MapComponent);
