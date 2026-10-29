import {createClient} from '@supabase/supabase-js';
import {createArenaHandler} from '../../server/arena-access.js';
export const handler=createArenaHandler({makeServer:()=>{
 const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw Error('Server not configured');
 return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
}});
