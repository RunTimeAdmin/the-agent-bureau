import { trpc } from "@/lib/trpc";
import { useCallback } from "react";

export function useAuth() {
  const utils = trpc.useUtils();

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: () => utils.auth.me.invalidate(),
  });

  const logoutMutation = trpc.auth.logout.useMutation({
    onSettled: () => utils.invalidate(),
  });

  const login = useCallback(
    (password: string) => loginMutation.mutate({ password }),
    [loginMutation]
  );

  const logout = useCallback(() => logoutMutation.mutate(), [logoutMutation]);

  return {
    isOperator: meQuery.data?.isOperator ?? false,
    loginConfigured: meQuery.data?.loginConfigured ?? false,
    loading: meQuery.isLoading,
    login,
    loginPending: loginMutation.isPending,
    loginError: loginMutation.error?.message ?? null,
    logout,
    logoutPending: logoutMutation.isPending,
  };
}
