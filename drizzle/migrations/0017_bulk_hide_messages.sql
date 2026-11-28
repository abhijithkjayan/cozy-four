CREATE OR REPLACE FUNCTION public.hide_messages_for_me(p_ids uuid[] DEFAULT NULL, p_peer uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.messages SET deleted_for = array_append(coalesce(deleted_for, '{}'), auth.uid())
  WHERE (sender_id = auth.uid() OR receiver_id = auth.uid())
    AND NOT (coalesce(deleted_for, '{}') @> ARRAY[auth.uid()])
    AND ((p_ids IS NOT NULL AND id = ANY(p_ids))
      OR (p_ids IS NULL AND p_peer IS NOT NULL AND (sender_id = p_peer OR receiver_id = p_peer)));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.hide_messages_for_me(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hide_messages_for_me(uuid[], uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';