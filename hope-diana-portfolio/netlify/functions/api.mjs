import {createHandler} from '../lib/app.mjs';
import {SupabaseRepository} from '../lib/supabase.mjs';
let handler;
export default async function(request,context){
 if(!handler){const env=process.env;const secret=env.SUPABASE_SECRET_KEY||env.SUPABASE_SERVICE_ROLE_KEY;const repo=env.SUPABASE_URL&&secret?new SupabaseRepository(env.SUPABASE_URL,secret):null;handler=createHandler(repo,env);}
 return handler(request,context);
}
