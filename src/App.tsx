import { createSignal, onMount, For, Show, type Component } from "solid-js";
import { createStore } from "solid-js/store";

import { Agent } from "@atproto/api";
import { BrowserOAuthClient } from "@atproto/oauth-client-browser";

enum RepoStatus {
  BLOCKEDBY = 1 << 0,
  BLOCKING = 1 << 1,
  DELETED = 1 << 2,
  DEACTIVATED = 1 << 3,
  SUSPENDED = 1 << 4,
  YOURSELF = 1 << 5,
  NONMUTUAL = 1 << 6,
}

type FollowRecord = {
  did: string;
  handle: string;
  uri: string;
  status: RepoStatus;
  status_label: string;
  toBeDeleted: boolean;
  visible: boolean;
};

const [followRecords, setFollowRecords] = createStore<FollowRecord[]>([]);
const [loginState, setLoginState] = createSignal(false);
let agent: Agent;

const resolveDid = async (did: string) => {
  const res = await fetch(
    did.startsWith("did:web") ?
      `https://${did.split(":")[2]}/.well-known/did.json`
    : "https://plc.directory/" + did,
  );

  return await res.json().then((doc) => {
    for (const alias of doc.alsoKnownAs) {
      if (alias.includes("at://")) {
        return alias.split("//")[1];
      }
    }
  });
};

const Login: Component = () => {
  const [loginInput, setLoginInput] = createSignal("");
  const [handle, setHandle] = createSignal("");
  const [notice, setNotice] = createSignal("");
  let client: BrowserOAuthClient;
  let sub: string;

  onMount(async () => {
    setNotice("Loading...");
    client = await BrowserOAuthClient.load({
      clientId: "https://cleanfollow-bsky.pages.dev/client-metadata.json",
      handleResolver: "https://boletus.us-west.host.bsky.network",
    });

    client.addEventListener("deleted", () => {
      setLoginState(false);
    });
    const result = await client.init().catch(() => {});

    if (result) {
      agent = new Agent(result.session);
      setLoginState(true);
      setHandle(await resolveDid(agent.did!));
      sub = result.session.sub;
    }
    setNotice("");
  });

  const loginBsky = async (handle: string) => {
    setNotice("Redirecting...");
    try {
      await client.signIn(handle, {
        scope: "atproto transition:generic",
        signal: new AbortController().signal,
      });
    } catch (err) {
      setNotice("Error during OAuth redirection");
    }
  };

  const logoutBsky = async () => {
    if (sub) await client.revoke(sub);
  };

  return (
    <div class="flex flex-col items-center">
      <Show when={!loginState() && !notice().includes("Loading")}>
        <form
          class="flex flex-col items-center"
          onsubmit={(e) => e.preventDefault()}
        >
          <label for="handle">Handle:</label>
          <input
            type="text"
            id="handle"
            placeholder="user.bsky.social"
            class="mb-3 mt-1 rounded-md px-2 py-1"
            onInput={(e) => setLoginInput(e.currentTarget.value)}
          />
          <button
            onclick={() => loginBsky(loginInput())}
            class="rounded bg-blue-500 px-4 py-2 font-bold text-white hover:bg-blue-700"
          >
            Login
          </button>
        </form>
      </Show>
      <Show when={loginState() && handle()}>
        <div class="mb-5">
          Logged in as {handle()} (
          <a href="" class="text-red-600" onclick={() => logoutBsky()}>
            Logout
          </a>
          )
        </div>
      </Show>
      <Show when={notice()}>
        <div class="m-3">{notice()}</div>
      </Show>
    </div>
  );
};

const Fetch: Component = () => {
  const [progress, setProgress] = createSignal(0);
  const [followCount, setFollowCount] = createSignal(0);
  const [notice, setNotice] = createSignal("");

  const fetchHiddenAccounts = async () => {
    const fetchFollows = async () => {
      const PAGE_LIMIT = 100;
      const fetchPage = async (cursor?: any) => {
        return await agent.com.atproto.repo.listRecords({
          repo: agent.did!,
          collection: "app.bsky.graph.follow",
          limit: PAGE_LIMIT,
          cursor: cursor,
        });
      };

      let res = await fetchPage();
      let follows = res.data.records;

      while (res.data.cursor && res.data.records.length >= PAGE_LIMIT) {
        res = await fetchPage(res.data.cursor);
        follows = follows.concat(res.data.records);
      }

      return follows;
    };

    setProgress(0);
    setNotice("");

    await fetchFollows().then((follows) => {
      setFollowCount(follows.length);
      follows.forEach(async (record: any) => {
        let status: RepoStatus | undefined = undefined;
        let handle = "";

        try {
          const res = await agent.getProfile({
            actor: record.value.subject,
          });

          handle = res.data.handle;
          const viewer = res.data.viewer!;

          if (!viewer.followedBy) status = RepoStatus.NONMUTUAL;

          if (viewer.blockedBy) {
            status =
              viewer.blocking || viewer.blockingByList ?
                RepoStatus.BLOCKEDBY | RepoStatus.BLOCKING
              : RepoStatus.BLOCKEDBY;
          } else if (res.data.did.includes(agent.did!)) {
            status = RepoStatus.YOURSELF;
          } else if (viewer.blocking || viewer.blockingByList) {
            status = RepoStatus.BLOCKING;
          }
        } catch (e: any) {
          handle = await resolveDid(record.value.subject);

          status =
            e.message.includes("not found") ? RepoStatus.DELETED
            : e.message.includes("deactivated") ? RepoStatus.DEACTIVATED
            : e.message.includes("suspended") ? RepoStatus.SUSPENDED
            : undefined;
        }

        const status_label =
          status == RepoStatus.DELETED ? "Deleted"
          : status == RepoStatus.DEACTIVATED ? "Deactivated"
          : status == RepoStatus.SUSPENDED ? "Suspended"
          : status == RepoStatus.NONMUTUAL ? "Non Mutual"
          : status == RepoStatus.YOURSELF ? "Literally Yourself"
          : status == RepoStatus.BLOCKING ? "Blocking"
          : status == RepoStatus.BLOCKEDBY ? "Blocked by"
          : RepoStatus.BLOCKEDBY | RepoStatus.BLOCKING ? "Mutual Block"
          : "";

        if (status !== undefined) {
          setFollowRecords(followRecords.length, {
            did: record.value.subject,
            handle: handle,
            uri: record.uri,
            status: status,
            status_label: status_label,
            toBeDeleted: false,
            visible: true,
          });
        }
        setProgress(progress() + 1);
      });
    });
  };

  const unfollow = async () => {
    const writes = followRecords
      .filter((record) => record.toBeDeleted)
      .map((record) => {
        return {
          $type: "com.atproto.repo.applyWrites#delete",
          collection: "app.bsky.graph.follow",
          rkey: record.uri.split("/").pop(),
        };
      });

    const BATCHSIZE = 200;
    for (let i = 0; i < writes.length; i += BATCHSIZE) {
      await agent.com.atproto.repo.applyWrites({
        repo: agent.did!,
        writes: writes.slice(i, i + BATCHSIZE),
      });
    }

    setFollowRecords([]);
    setProgress(0);
    setFollowCount(0);
    setNotice(
      `Unfollowed ${writes.length} account${writes.length > 1 ? "s" : ""}`,
    );
  };

  return (
    <div class="flex flex-col items-center">
      <Show when={!followRecords.length}>
        <button
          type="button"
          onclick={() => fetchHiddenAccounts()}
          class="rounded bg-blue-500 px-4 py-2 font-bold text-white hover:bg-blue-700"
        >
          Preview
        </button>
      </Show>
      <Show when={followRecords.length}>
        <button
          type="button"
          onclick={() => unfollow()}
          class="rounded bg-green-500 px-4 py-2 font-bold text-white hover:bg-green-700"
        >
          Confirm
        </button>
      </Show>
      <Show when={notice()}>
        <div class="m-3">{notice()}</div>
      </Show>
      <Show when={followCount()}>
        <div class="m-3">
          Progress: {progress()}/{followCount()}
        </div>
      </Show>
    </div>
  );
};

const Follows: Component = () => {
  function editRecords(
    status: RepoStatus,
    field: keyof FollowRecord,
    value: boolean,
  ) {
    followRecords.forEach((record, index) => {
      if (record.status & status) setFollowRecords(index, field, value);
    });
  }

  const options: { status: RepoStatus; label: string }[] = [
    { status: RepoStatus.DELETED, label: "Deleted" },
    { status: RepoStatus.DEACTIVATED, label: "Deactivated" },
    { status: RepoStatus.SUSPENDED, label: "Suspended" },
    { status: RepoStatus.BLOCKEDBY, label: "Blocked By" },
    { status: RepoStatus.BLOCKING, label: "Blocking" },
    { status: RepoStatus.NONMUTUAL, label: "Non Mutual" },
  ];

  return (
    <div class="mt-3 flex flex-col sm:w-full sm:flex-row sm:justify-center">
      <div class="sticky top-0 mb-3 mr-5 flex w-full flex-wrap justify-around border-b border-b-gray-400 bg-white pb-3 sm:top-3 sm:mb-0 sm:w-auto sm:flex-col sm:self-start sm:border-none">
        <For each={options}>
          {(option, index) => (
            <div
              classList={{
                "sm:pb-2 min-w-36 sm:mb-2 mt-3 sm:mt-0": true,
                "sm:border-b sm:border-b-gray-300":
                  index() < options.length - 1,
              }}
            >
              <div>
                <label class="mb-2 mt-1 inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    class="peer sr-only"
                    checked
                    onChange={(e) =>
                      editRecords(
                        option.status,
                        "visible",
                        e.currentTarget.checked,
                      )
                    }
                  />
                  <span class="peer relative h-5 w-9 rounded-full bg-gray-200 after:absolute after:start-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:border-gray-600 dark:bg-gray-700 dark:peer-focus:ring-blue-800 rtl:peer-checked:after:-translate-x-full"></span>
                  <span class="ms-3 select-none dark:text-gray-300">
                    {option.label}
                  </span>
                </label>
              </div>
              <div class="flex items-center">
                <input
                  type="checkbox"
                  id={option.label}
                  class="h-4 w-4 rounded"
                  onChange={(e) =>
                    editRecords(
                      option.status,
                      "toBeDeleted",
                      e.currentTarget.checked,
                    )
                  }
                />
                <label for={option.label} class="ml-2 select-none">
                  Select All
                </label>
              </div>
            </div>
          )}
        </For>
      </div>
      <div class="sm:w-1/2">
        <For each={followRecords}>
          {(record, index) => (
            <Show when={record.visible}>
              <div class="mb-2 flex items-center border-b pb-2">
                <div class="mr-4">
                  <input
                    type="checkbox"
                    id={"record" + index()}
                    class="h-4 w-4 rounded"
                    checked={record.toBeDeleted}
                    onChange={(e) =>
                      setFollowRecords(
                        index(),
                        "toBeDeleted",
                        e.currentTarget.checked,
                      )
                    }
                  />
                </div>
                <div>
                  <label for={"record" + index()} class="flex flex-col">
                    <span>@{record.handle}</span>
                    <span>{record.did}</span>
                    <span>{record.status_label}</span>
                  </label>
                </div>
              </div>
            </Show>
          )}
        </For>
      </div>
    </div>
  );
};

const App: Component = () => {
  return (
    <div class="m-5 flex flex-col items-center">
      <h1 class="mb-5 text-2xl">cleanfollow-bsky</h1>
      <div class="mb-3 text-center">
        <p>Unfollow blocked, deleted, suspended, and deactivated accounts</p>
        <p>By default, every account will be unselected</p>
        <div>
          <a
            class="text-blue-600 hover:underline"
            href="https://github.com/notjuliet/cleanfollow-bsky"
          >
            Source Code
          </a>
          <span> | </span>
          <a
            class="text-blue-600 hover:underline"
            href="https://bsky.app/profile/adorable.mom"
          >
            Bluesky
          </a>
          <span> | </span>
          <a
            class="text-blue-600 hover:underline"
            href="https://mary-ext.codeberg.page/bluesky-quiet-posters/"
          >
            Quiet Posters
          </a>
        </div>
      </div>
      <Login />
      <Show when={loginState()}>
        <Fetch />
        <Show when={followRecords.length}>
          <Follows />
        </Show>
      </Show>
    </div>
  );
};

export default App;
