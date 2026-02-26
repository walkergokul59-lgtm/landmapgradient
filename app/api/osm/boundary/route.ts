
import { NextResponse } from 'next/server';
import osmtogeojson from 'osmtogeojson';

const OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const osmId = searchParams.get('osm_id');
    const osmType = searchParams.get('osm_type'); // should be 'relation' or 'way'

    if (!osmId || !osmType) {
        return NextResponse.json({ error: 'osm_id and osm_type are required' }, { status: 400 });
    }

    // Map osm_type string (node/way/relation) to Overpass query type
    // Usually we search for boundaries, so it's relation or way.
    // Note: Nominatim usually returns 'relation' for administrative boundaries.
    // Query: [out:json]; relation(ID); out geom;
    // If type is way: way(ID); out geom;

    let typeShort = '';
    if (osmType === 'relation') typeShort = 'rel';
    else if (osmType === 'way') typeShort = 'way';
    else {
        // Fallback or error? Let's just try relation if unknown or return error.
        return NextResponse.json({ error: 'Invalid osm_type. Must be relation or way.' }, { status: 400 });
    }

    const query = `[out:json]; ${typeShort}(${osmId}); out geom;`;

    try {
        const res = await fetch(OVERPASS_API_URL, {
            method: 'POST',
            body: query,
            // headers: { 'Content-Type': 'text/plain' }
        });

        if (!res.ok) {
            throw new Error(`Overpass API error: ${res.statusText}`);
        }

        const osmData = await res.json();
        const geojson = osmtogeojson(osmData);

        return NextResponse.json(geojson);

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
