-- The join page shows who invited you before you sign in; it still needs the secret token.
grant execute on function public.invite_preview(text) to anon;
