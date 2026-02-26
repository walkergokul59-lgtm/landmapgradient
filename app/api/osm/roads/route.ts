
import { NextResponse } from 'next/server';
import osmtogeojson from 'osmtogeojson';

const OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { bbox, types } = body;

        if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
            return NextResponse.json({ error: 'Valid BBox [minX, minY, maxX, maxY] is required' }, { status: 400 });
        }

        if (!types || !Array.isArray(types) || types.length === 0) {
            return NextResponse.json({ error: 'At least one road type is required' }, { status: 400 });
        }

        // Convert types array to regex string for Overpass
        // e.g., types=["primary", "secondary"] -> "primary|secondary"
        const typeRegex = types.join('|');

        // Construct Overpass QL
        // BBox in Overpass is (south, west, north, east) -> (minY, minX, maxY, maxX)
        // Turf/GeoJSON bbox is [minX, minY, maxX, maxY]
        const [minX, minY, maxX, maxY] = bbox;
        const overpassBbox = `${minY},${minX},${maxY},${maxX}`;

        // Query: ways with highway matching regex in bbox
        const query = `
      [out:json][timeout:25];
      (
        way["highway"~"^(${typeRegex})$"](${overpassBbox});
      );
      out geom;
    `;

        // console.log("Overpass Query:", query);

        const res = await fetch(OVERPASS_API_URL, {
            method: 'POST',
            body: query,
        });

        if (!res.ok) {
            throw new Error(`Overpass API error: ${res.statusText}`);
        }

        const osmData = await res.json();
        const geojson = osmtogeojson(osmData);

        return NextResponse.json(geojson);

    } catch (error: any) {
        console.error("Roads API Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
