import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabase = createClient(supabaseUrl || "http://localhost", supabaseAnonKey || "placeholder");

export type VideoRun = {
  id: string;
  company_slug: string;
  source_url: string;
  product_title: string | null;
  product_category: string | null;
  occasion?: "auto" | "casual" | "partywear" | "marriage" | "workwear" | "festive";
  status: "queued" | "processing" | "completed" | "failed";
  provider: string;
  provider_job_id: string | null;
  input_images: string[];
  prompt: string | null;
  output_video_url: string | null;
  thumbnail_url: string | null;
  preview_images?: string[];
  preview_error?: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};
