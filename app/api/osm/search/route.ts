
import { NextResponse } from 'next/server';

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');

    if (!q) {
        return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });
    }

    try {
        const params = new URLSearchParams({
            q,
            format: 'json',
            polygon_geojson: '1',
            addressdetails: '1',
            limit: '5'
        });

        const url = `${NOMINATIM_BASE_URL}?${params.toString()}`;

        // Polite User Agent
        const headers = {
            'User-Agent': 'LandValueGradientApp/1.0',
            'Referer': 'http://localhost:3000'
        };

        const res = await fetch(url, { headers });
        if (!res.ok) {
            throw new Error(`Nominatim API error: ${res.statusText}`);
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (error: any) {
        console.error("Search API Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
