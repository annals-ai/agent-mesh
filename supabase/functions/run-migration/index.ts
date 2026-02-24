import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js"
const corsHeaders = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'}
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  const sql = postgres(dbUrl, { max: 1 })
  try {
    const { query } = await req.json()
    const result = await sql.unsafe(query)
    await sql.end()
    return new Response(JSON.stringify({ success: true, rows: result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    await sql.end()
    return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 })
  }
})
