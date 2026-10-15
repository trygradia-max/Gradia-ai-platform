import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeDestination } from "@/lib/contact-destination"
import { recordCommandSchema, type RecordCommand } from "./record-command"
type Fields={phone?:string|null;email?:string|null;vehicle_make?:string|null;vehicle_model?:string|null;vehicle_year?:number|null;vehicle_color?:string|null}
/** Read-only preparation: bind exact records and snapshots before presenting edits. */
export async function prepareCustomerEdit(db:SupabaseClient,shopId:string,customerId:string,fields:Fields):Promise<{ok:true;command:RecordCommand}|{ok:false;error:string}>{
 try {
  const c=await db.from("customers").select("id,shop_id,name,phone,email,updated_at").eq("shop_id",shopId).eq("id",customerId).single()
  if(c.error||c.data?.id!==customerId||c.data?.shop_id!==shopId)return {ok:false,error:"Customer could not be verified in this shop."}
  const changes:Record<string,string>={}
  for(const [field,channel] of [["phone","sms"],["email","email"]] as const){
   if(fields[field]!=null){const value=normalizeDestination(channel,fields[field]);if(!value)return {ok:false,error:`Invalid ${field}; confirm the complete destination first.`};changes[field]=value}
  }
  const vehicleChanges:Record<string,string|number>={}
  for(const [field,key] of [["vehicle_make","make"],["vehicle_model","model"],["vehicle_color","color"],["vehicle_year","year"]] as const){
   const value=fields[field];if(value!=null)vehicleChanges[key]=typeof value==='string'?value.trim():value
  }
  let vehicle=null
  if(Object.keys(vehicleChanges).length){
   const v=await db.from("vehicles").select("id,shop_id,customer_id,updated_at,make,model,year,color").eq("shop_id",shopId).eq("customer_id",customerId).limit(2)
   if(v.error||!v.data||v.data.some(row=>row.shop_id!==shopId||row.customer_id!==customerId))return {ok:false,error:"Vehicle ownership could not be verified."}
   if(v.data.length>1)return {ok:false,error:"This customer has multiple vehicles. Select the vehicle in the CRM before editing."}
   if(!v.data.length&&!vehicleChanges.make)return {ok:false,error:"A make is required to add a new vehicle."}
   vehicle={before:v.data[0]?{make:v.data[0].make,model:v.data[0].model,year:v.data[0].year,color:v.data[0].color}:null,id:v.data[0]?.id??null,expected_updated_at:v.data[0]?.updated_at??null,changes:vehicleChanges}
  }
  const parsed=recordCommandSchema.safeParse({type:"update_customer",payload:{customer_id:customerId,before:{name:c.data.name,phone:c.data.phone,email:c.data.email},expected_updated_at:c.data.updated_at,changes,vehicle}})
  return parsed.success?{ok:true,command:parsed.data}:{ok:false,error:"No valid customer or vehicle changes were supplied."}
 }catch{return {ok:false,error:"Customer edit could not be prepared. Nothing was changed."}}
}
