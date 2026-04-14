-- Morphly current Supabase schema
-- Safe to run on an existing project. It creates missing tables and adds
-- the credits/session/payment columns the current app expects.

create extension if not exists "uuid-ossp";

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.users add column if not exists email text;
alter table public.users add column if not exists name text;
alter table public.users add column if not exists created_at timestamp with time zone not null default now();
alter table public.users add column if not exists updated_at timestamp with time zone not null default now();

create table if not exists public.wallets (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  balance numeric(12, 2) not null default 0,
  credits integer not null default 0,
  currency text not null default 'NGN',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (user_id)
);

alter table public.wallets add column if not exists balance numeric(12, 2) not null default 0;
alter table public.wallets add column if not exists credits integer not null default 0;
alter table public.wallets add column if not exists currency text not null default 'NGN';
alter table public.wallets add column if not exists created_at timestamp with time zone not null default now();
alter table public.wallets add column if not exists updated_at timestamp with time zone not null default now();

create table if not exists public.transactions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric(12, 2) not null default 0,
  credits integer not null default 0,
  type text not null check (type in ('credit', 'debit')),
  status text not null default 'success' check (status in ('pending', 'success', 'failed', 'refunded')),
  reference text,
  description text,
  created_at timestamp with time zone not null default now()
);

alter table public.transactions add column if not exists amount numeric(12, 2) not null default 0;
alter table public.transactions add column if not exists credits integer not null default 0;
alter table public.transactions add column if not exists type text;
alter table public.transactions add column if not exists status text not null default 'success';
alter table public.transactions add column if not exists reference text;
alter table public.transactions add column if not exists description text;
alter table public.transactions add column if not exists created_at timestamp with time zone not null default now();

create table if not exists public.sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  start_time timestamp with time zone not null default now(),
  end_time timestamp with time zone,
  seconds_used integer not null default 0,
  cost numeric(12, 2) not null default 0,
  status text not null default 'active' check (status in ('active', 'ended', 'interrupted')),
  created_at timestamp with time zone not null default now()
);

alter table public.sessions add column if not exists start_time timestamp with time zone not null default now();
alter table public.sessions add column if not exists end_time timestamp with time zone;
alter table public.sessions add column if not exists seconds_used integer not null default 0;
alter table public.sessions add column if not exists cost numeric(12, 2) not null default 0;
alter table public.sessions add column if not exists status text not null default 'active';
alter table public.sessions add column if not exists created_at timestamp with time zone not null default now();

create table if not exists public.subscriptions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  plan_name text not null,
  amount_paid numeric(12, 2) not null default 0,
  credits integer not null default 0,
  status text not null default 'active' check (status in ('active', 'expired', 'cancelled', 'pending')),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.subscriptions add column if not exists plan_name text;
alter table public.subscriptions add column if not exists amount_paid numeric(12, 2) not null default 0;
alter table public.subscriptions add column if not exists credits integer not null default 0;
alter table public.subscriptions add column if not exists status text not null default 'active';
alter table public.subscriptions add column if not exists created_at timestamp with time zone not null default now();
alter table public.subscriptions add column if not exists updated_at timestamp with time zone not null default now();

create table if not exists public.plans (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  price_usd numeric(12, 2) not null default 0,
  credits integer not null default 0,
  duration_seconds integer not null default 0,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.plans add column if not exists price_usd numeric(12, 2) not null default 0;
alter table public.plans add column if not exists credits integer not null default 0;
alter table public.plans add column if not exists duration_seconds integer not null default 0;
alter table public.plans add column if not exists is_active boolean not null default true;
alter table public.plans add column if not exists sort_order integer not null default 0;
alter table public.plans add column if not exists created_at timestamp with time zone not null default now();
alter table public.plans add column if not exists updated_at timestamp with time zone not null default now();

create index if not exists idx_wallets_user_id on public.wallets(user_id);
create index if not exists idx_transactions_user_id on public.transactions(user_id);
create index if not exists idx_transactions_reference on public.transactions(reference);
create index if not exists idx_sessions_user_id on public.sessions(user_id);
create index if not exists idx_sessions_status on public.sessions(status);
create index if not exists idx_subscriptions_user_id on public.subscriptions(user_id);
create index if not exists idx_plans_sort_order on public.plans(sort_order);

alter table public.users enable row level security;
alter table public.wallets enable row level security;
alter table public.transactions enable row level security;
alter table public.sessions enable row level security;
alter table public.subscriptions enable row level security;
alter table public.plans enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'users' and policyname = 'Users can view own profile'
  ) then
    create policy "Users can view own profile"
      on public.users for select
      using (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'users' and policyname = 'Users can update own profile'
  ) then
    create policy "Users can update own profile"
      on public.users for update
      using (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'users' and policyname = 'Users can insert own profile'
  ) then
    create policy "Users can insert own profile"
      on public.users for insert
      with check (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'wallets' and policyname = 'Users can access own wallet'
  ) then
    create policy "Users can access own wallet"
      on public.wallets for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'transactions' and policyname = 'Users can access own transactions'
  ) then
    create policy "Users can access own transactions"
      on public.transactions for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sessions' and policyname = 'Users can access own sessions'
  ) then
    create policy "Users can access own sessions"
      on public.sessions for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'subscriptions' and policyname = 'Users can access own subscriptions'
  ) then
    create policy "Users can access own subscriptions"
      on public.subscriptions for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'plans' and policyname = 'Authenticated users can view plans'
  ) then
    create policy "Authenticated users can view plans"
      on public.plans for select
      using (auth.role() = 'authenticated');
  end if;
end
$$;

create or replace function public.update_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do update set email = excluded.email;

  insert into public.wallets (user_id, balance, credits)
  values (new.id, 0, 0)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

drop trigger if exists update_users_updated_at on public.users;
create trigger update_users_updated_at
  before update on public.users
  for each row
  execute function public.update_updated_at();

drop trigger if exists update_wallets_updated_at on public.wallets;
create trigger update_wallets_updated_at
  before update on public.wallets
  for each row
  execute function public.update_updated_at();

drop trigger if exists update_subscriptions_updated_at on public.subscriptions;
create trigger update_subscriptions_updated_at
  before update on public.subscriptions
  for each row
  execute function public.update_updated_at();

drop trigger if exists update_plans_updated_at on public.plans;
create trigger update_plans_updated_at
  before update on public.plans
  for each row
  execute function public.update_updated_at();

insert into public.users (id, email)
select au.id, coalesce(au.email, '')
from auth.users au
on conflict (id) do update set email = excluded.email;

insert into public.wallets (user_id, balance, credits)
select u.id, 0, 0
from public.users u
left join public.wallets w on w.user_id = u.id
where w.user_id is null;

insert into public.plans (name, price_usd, credits, duration_seconds, sort_order)
values
  ('500 Credits', 9500, 500, 250, 1),
  ('1,000 Credits', 19000, 1000, 500, 2),
  ('2,000 Credits', 38000, 2000, 1000, 3),
  ('5,000 Credits', 95000, 5000, 2500, 4)
on conflict (name) do update set
  price_usd = excluded.price_usd,
  credits = excluded.credits,
  duration_seconds = excluded.duration_seconds,
  sort_order = excluded.sort_order,
  is_active = true;
