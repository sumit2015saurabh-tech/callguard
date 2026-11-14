-- CallGuard: run ONCE in Supabase → SQL Editor → New query → Run.
-- Stores each account's user ID, lets people log in with "user ID + password",
-- and stops two accounts from taking the same user ID. Passwords stay in Supabase Auth (hashed).

create table if not exists public.profiles (
  id      uuid primary key references auth.users on delete cascade,
  user_id text unique not null,
  name    text
);
alter table public.profiles enable row level security;
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (auth.uid() = id);

-- New account -> profile row. Google sign-ups get a user ID made from the email (plus 4 characters).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, user_id, name) values (
    new.id,
    coalesce(lower(new.raw_user_meta_data->>'user_id'),
             left(regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9_.]', '', 'g'), 14)
               || substr(replace(new.id::text, '-', ''), 1, 4)),
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Login with a user ID: look up that account's email (used only by the login form).
create or replace function public.email_for_user_id(uid text) returns text
language sql security definer set search_path = '' stable as $$
  select u.email from auth.users u join public.profiles p on p.id = u.id where p.user_id = lower(uid)
$$;
-- Sign-up form: is this user ID already taken?
create or replace function public.user_id_taken(uid text) returns boolean
language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.profiles where user_id = lower(uid))
$$;
revoke all on function public.email_for_user_id(text), public.user_id_taken(text) from public;
grant execute on function public.email_for_user_id(text), public.user_id_taken(text) to anon, authenticated;
