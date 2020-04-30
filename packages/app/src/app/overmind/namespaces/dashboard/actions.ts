import { Action, AsyncAction } from 'app/overmind';
import { withLoadApp, TEAM_ID_LOCAL_STORAGE } from 'app/overmind/factories';
import downloadZip from 'app/overmind/effects/zip/create-zip';
import { uniq } from 'lodash-es';
import {
  Direction,
  TemplateFragmentDashboardFragment,
} from 'app/graphql/types';
import Fuse from 'fuse.js';
import { OrderBy, sandboxesTypes } from './state';

const VIEW_MODE_DASHBOARD = 'VIEW_MODE_DASHBOARD';

// DELETE WHEN NEW DASHBOARD ONLINE
export const dashboardMounted: AsyncAction = async (context, value) => {
  await withLoadApp()(context, value);
};

export const newDashboardMounted: Action = ({ state, effects }) => {
  const localStorageViewMode = effects.browser.storage.get(VIEW_MODE_DASHBOARD);
  if (localStorageViewMode) {
    state.dashboard.viewMode = localStorageViewMode;
  }
};
export const sandboxesSelected: Action<{
  sandboxIds: string[];
}> = ({ state }, { sandboxIds }) => {
  state.dashboard.selectedSandboxes = sandboxIds;
};

export const setTrashSandboxes: Action<{
  sandboxIds: string[];
}> = ({ state }, { sandboxIds }) => {
  state.dashboard.trashSandboxIds = sandboxIds;
};

export const setActiveTeam: Action<{
  id: string;
}> = ({ state, effects }, { id }) => {
  // if the team is already selected, do nothing
  if (id === state.dashboard.activeTeam) return;

  state.dashboard.activeTeam = id;
  effects.browser.storage.set(TEAM_ID_LOCAL_STORAGE, id);
  state.dashboard.sandboxes = {
    ...state.dashboard.sandboxes,
    DRAFTS: null,
    TEMPLATES: null,
    RECENT: null,
    SEARCH: null,
    ALL: null,
  };
};

export const dragChanged: Action<{ isDragging: boolean }> = (
  { state },
  { isDragging }
) => {
  state.dashboard.isDragging = isDragging;
};

export const orderByChanged: Action<OrderBy> = ({ state }, orderBy) => {
  state.dashboard.orderBy = orderBy;
};

export const blacklistedTemplateAdded: Action<string> = (
  { state },
  template
) => {
  state.dashboard.filters.blacklistedTemplates.push(template);
};

export const blacklistedTemplateRemoved: Action<string> = (
  { state },
  template
) => {
  state.dashboard.filters.blacklistedTemplates = state.dashboard.filters.blacklistedTemplates.filter(
    currentTemplate => currentTemplate !== template
  );
};

export const blacklistedTemplatesCleared: Action = ({ state }) => {
  state.dashboard.filters.blacklistedTemplates = [];
};

export const blacklistedTemplatesChanged: Action<string[]> = (
  { state },
  templates
) => {
  state.dashboard.filters.blacklistedTemplates = templates;
};

export const searchChanged: Action<{ search: string }> = (
  { state },
  { search }
) => {
  state.dashboard.filters.search = search;
};

export const viewModeChanged: Action<{ mode: 'grid' | 'list' }> = (
  { state, effects },
  { mode }
) => {
  state.dashboard.viewMode = mode;
  effects.browser.storage.set(VIEW_MODE_DASHBOARD, mode);
};

export const createSandboxClicked: AsyncAction<{
  body: { collectionId: string };
  sandboxId: string;
}> = ({ actions }, { body, sandboxId }) =>
  actions.editor.forkExternalSandbox({ body, sandboxId });

export const deleteTemplate: AsyncAction<{
  sandboxId: string;
  templateId: string;
}> = async ({ actions, effects }, { sandboxId, templateId }) => {
  try {
    effects.analytics.track('Template - Removed', { source: 'Context Menu' });
    await effects.api.deleteTemplate(sandboxId, templateId);
    actions.modalClosed();
    effects.notificationToast.success('Template Deleted');
  } catch (error) {
    effects.notificationToast.error('Could not delete custom template');
  }
};

export const getTeams: AsyncAction = async ({ state, effects }) => {
  if (!state.user) return;
  const teams = await effects.gql.queries.getTeams({});

  if (!teams || !teams.me) {
    return;
  }

  state.dashboard.teams = teams.me.teams;
};
export const getRecentSandboxes: AsyncAction = withLoadApp(
  async ({ state, effects }) => {
    const { dashboard } = state;
    try {
      const data = await effects.gql.queries.recentSandboxes({
        limit: 200,
        orderField: dashboard.orderBy.field,
        orderDirection: dashboard.orderBy.order.toUpperCase() as Direction,
      });
      if (!data || !data.me) {
        return;
      }

      dashboard.sandboxes[sandboxesTypes.RECENT] = data.me.sandboxes
        .filter(
          sandbox =>
            (sandbox.collection || { collection: {} }).teamId ===
            state.dashboard.activeTeam
        )
        .slice(0, 50);
    } catch (error) {
      effects.notificationToast.error(
        'There was a problem getting your recent Sandboxes'
      );
    }
  }
);

export const getAllFolders: AsyncAction = withLoadApp(
  async ({ state, effects }) => {
    try {
      const data = await effects.gql.queries.getCollections({
        teamId: state.dashboard.activeTeam,
      });
      if (!data || !data.me || !data.me.collections) {
        return;
      }

      // this is here because it will be done in the backend in the *FUTURE*
      const collectionsByLevel = data.me.collections.map(collection => {
        const split = collection.path.split('/');
        return {
          ...collection,
          sandboxes: collection.sandboxes.length,
          parent: split.slice(0, split.length - 1).find(a => a) || '',
          level: split.length - 2,
          name: split[split.length - 1],
        };
      });

      state.dashboard.allCollections = [
        {
          id: 'drafts-fake-id',
          sandboxes: (
            data.me.collections.find(folder => folder.path === '/') || {
              sandboxes: [],
            }
          ).sandboxes.length,
          parent: '',
          name: 'Drafts',
          level: 0,
          path: '/drafts',
        },
        ...collectionsByLevel.filter(c => c.id && c.name),
      ];
    } catch {
      effects.notificationToast.error(
        'There was a problem getting your Sandboxes'
      );
    }
  }
);

export const createFolder: AsyncAction<string> = async (
  { effects, state },
  path
) => {
  if (!state.dashboard.allCollections) return;
  const split = path.split('/');
  const oldFolders = state.dashboard.allCollections;
  state.dashboard.allCollections = [
    {
      path,
      id: 'FAKE_ID',
      sandboxes: 0,
      parent: split.slice(0, split.length - 1).find(a => a) || '',
      level: split.length - 2,
      name: split[split.length - 1],
    },
    ...state.dashboard.allCollections,
  ];
  try {
    const { createCollection } = await effects.gql.mutations.createFolder({
      // only way to pass, null is a value in the BE
      // @ts-ignore
      teamId: state.dashboard.activeTeam || undefined,
      path,
    });

    state.dashboard.allCollections = state.dashboard.allCollections.map(
      folder => {
        if (folder.id === 'FAKE_ID') {
          return {
            ...folder,
            id: createCollection.id,
            path: createCollection.path,
          };
        }

        return folder;
      }
    );
  } catch {
    state.dashboard.allCollections = [...oldFolders];
    effects.notificationToast.error('There was a problem creating your folder');
  }
};

export const getDrafts: AsyncAction = withLoadApp(
  async ({ state, effects }) => {
    const { dashboard } = state;
    try {
      const data = await effects.gql.queries.sandboxesByPath({
        path: '/',
        teamId: state.dashboard.activeTeam,
      });
      if (!data || !data.me || !data.me.collection) {
        return;
      }

      dashboard.sandboxes[
        sandboxesTypes.DRAFTS
      ] = data.me.collection.sandboxes.filter(s => !s.customTemplate);
    } catch (error) {
      effects.notificationToast.error(
        'There was a problem getting your Sandboxes'
      );
    }
  }
);

export const getSandboxesByPath: AsyncAction<string> = withLoadApp(
  async ({ state, effects }, path) => {
    const { dashboard } = state;
    const cleanPath = path.split(' ').join('');
    try {
      const data = await effects.gql.queries.sandboxesByPath({
        path: '/' + path,
        teamId: state.dashboard.activeTeam,
      });
      if (!data || !data.me || !data.me.collection) {
        return;
      }

      if (!dashboard.sandboxes.ALL) {
        dashboard.sandboxes.ALL = {};
      }

      dashboard.sandboxes.ALL[cleanPath] = data.me.collection.sandboxes.filter(
        s => !s.customTemplate
      );
    } catch (error) {
      effects.notificationToast.error(
        'There was a problem getting your Sandboxes'
      );
    }
  }
);

export const getDeletedSandboxes: AsyncAction = withLoadApp(
  async ({ state, effects }) => {
    const { dashboard } = state;
    try {
      const data = await effects.gql.queries.deletedSandboxes({});
      if (!data || !data.me) {
        return;
      }
      dashboard.sandboxes[sandboxesTypes.DELETED] = data.me.sandboxes;
    } catch (error) {
      effects.notificationToast.error(
        'There was a problem getting your deleted Sandboxes'
      );
    }
  }
);

export const getTemplateSandboxes: AsyncAction = withLoadApp(
  async ({ state, effects }) => {
    const { dashboard } = state;
    try {
      if (dashboard.activeTeam) {
        dashboard.sandboxes[sandboxesTypes.TEMPLATES] = null;
        const data = await effects.gql.queries.teamTemplates({
          id: dashboard.activeTeam,
        });

        if (!data || !data.me || !data.me.team) {
          return;
        }

        dashboard.sandboxes[sandboxesTypes.TEMPLATES] = data.me.team.templates;
      } else {
        dashboard.sandboxes[sandboxesTypes.TEMPLATES] = null;
        const data = await effects.gql.queries.ownedTemplates({
          showAll: false,
        });
        if (!data || !data.me) {
          return;
        }

        dashboard.sandboxes[sandboxesTypes.TEMPLATES] = data.me.templates;
      }
    } catch (error) {
      effects.notificationToast.error(
        'There was a problem getting your Templates'
      );
    }
  }
);

export const getStartPageSandboxes: AsyncAction = withLoadApp(
  async ({ state, effects }) => {
    const { dashboard } = state;
    try {
      const usedTemplates = await effects.gql.queries.listPersonalTemplates({});

      if (!usedTemplates || !usedTemplates.me) {
        return;
      }

      dashboard.sandboxes.TEMPLATE_START_PAGE = usedTemplates.me.recentlyUsedTemplates.slice(
        0,
        4
      );

      const recentSandboxes = await effects.gql.queries.recentSandboxes({
        limit: 7,
        orderField: dashboard.orderBy.field,
        orderDirection: dashboard.orderBy.order.toUpperCase() as Direction,
      });

      if (!recentSandboxes || !recentSandboxes.me) {
        return;
      }
      dashboard.sandboxes.RECENT_START_PAGE = recentSandboxes.me.sandboxes;
    } catch (error) {
      effects.notificationToast.error(
        'There was a problem getting your Sandboxes'
      );
    }
  }
);

export const deleteSandboxFromState: Action<string[]> = (
  { state: { dashboard } },
  ids
) => {
  ids.map(id => {
    const values = Object.keys(dashboard.sandboxes).map(type => {
      if (dashboard.sandboxes[type]) {
        return dashboard.sandboxes[type].filter(sandbox => sandbox.id !== id);
      }

      return null;
    });

    dashboard.sandboxes = values.reduce(
      (initial, current, i) =>
        Object.assign(initial, {
          [Object.keys(dashboard.sandboxes)[i]]: current,
        }),
      {}
    );
    return null;
  });
};

export const deleteTemplateFromState: Action<string[]> = (
  { state: { dashboard } },
  ids
) => {
  const { sandboxes } = dashboard;
  ids.map(id => {
    if (sandboxes.TEMPLATE_START_PAGE) {
      sandboxes.TEMPLATE_START_PAGE = sandboxes.TEMPLATE_START_PAGE
        ? sandboxes.TEMPLATE_START_PAGE.filter(
            ({ sandbox }: TemplateFragmentDashboardFragment) =>
              sandbox && sandbox.id !== id
          )
        : null;
    }

    if (sandboxes.TEMPLATES) {
      sandboxes.TEMPLATES = sandboxes.TEMPLATES
        ? sandboxes.TEMPLATES.filter(
            ({ sandbox }: TemplateFragmentDashboardFragment) =>
              sandbox && sandbox.id !== id
          )
        : null;
    }

    return null;
  });
};

export const deleteSandbox: AsyncAction<string[]> = async (
  { state, effects, actions },
  ids
) => {
  const { user } = state;
  if (!user) return;
  const oldSandboxes = state.dashboard.sandboxes;
  actions.dashboard.deleteSandboxFromState(ids);

  try {
    await effects.gql.mutations.deleteSandboxes({
      sandboxIds: ids,
    });
  } catch (error) {
    state.dashboard.sandboxes = { ...oldSandboxes };
    effects.notificationToast.error(
      'There was a problem deleting your Sandbox'
    );
  }
};

export const unmakeTemplate: AsyncAction<string[]> = async (
  { effects, actions, state },
  ids
) => {
  const oldTemplates = {
    TEMPLATE_START_PAGE: state.dashboard.sandboxes.TEMPLATE_START_PAGE,
    TEMPLATES: state.dashboard.sandboxes.TEMPLATES,
  };
  actions.dashboard.deleteTemplateFromState(ids);
  try {
    await effects.gql.mutations.unmakeSandboxesTemplate({ sandboxIds: ids });
  } catch (error) {
    state.dashboard.sandboxes.TEMPLATES = oldTemplates.TEMPLATES
      ? [...oldTemplates.TEMPLATES]
      : null;
    state.dashboard.sandboxes.TEMPLATE_START_PAGE = oldTemplates.TEMPLATE_START_PAGE
      ? [...oldTemplates.TEMPLATE_START_PAGE]
      : null;
    effects.notificationToast.error(
      'There was a problem reverting your template'
    );
  }
};

export const renameSandboxInState: Action<{
  id: string;
  title: string;
}> = ({ state: { dashboard } }, { id, title }) => {
  const values = Object.keys(dashboard.sandboxes).map(type => {
    if (dashboard.sandboxes[type]) {
      return dashboard.sandboxes[type].map(sandbox => {
        if (sandbox.id === id) {
          return {
            ...sandbox,
            title,
          };
        }

        return sandbox;
      });
    }

    return null;
  });

  dashboard.sandboxes = values.reduce(
    (initial, current, i) =>
      Object.assign(initial, {
        [Object.keys(dashboard.sandboxes)[i]]: current,
      }),
    {}
  );
};

export const renameFolderInState: Action<{ path: string; newPath: string }> = (
  { state: { dashboard } },
  { path, newPath }
) => {
  if (!dashboard.allCollections) return;
  dashboard.allCollections = dashboard.allCollections.map(folder => {
    if (folder.path === path) {
      return {
        ...folder,
        path: newPath,
        name,
      };
    }

    return folder;
  });
};

export const renameSandbox: AsyncAction<{
  id: string;
  title: string;
  oldTitle: string;
}> = async ({ effects, actions }, { id, title, oldTitle }) => {
  actions.dashboard.renameSandboxInState({
    id,
    title,
  });
  try {
    await effects.gql.mutations.renameSandbox({
      id,
      title,
    });
  } catch {
    actions.dashboard.renameSandboxInState({
      id,
      title: oldTitle,
    });
    effects.notificationToast.error('There was a problem renaming you sandbox');
  }
};

export const renameFolder: AsyncAction<{
  path: string;
  newPath: string;
}> = async ({ state: { dashboard }, effects, actions }, { path, newPath }) => {
  if (!dashboard.allCollections) return;
  actions.dashboard.renameFolderInState({
    path,
    newPath,
  });

  try {
    await effects.gql.mutations.renameFolder({
      newPath,
      path,
    });
  } catch {
    actions.dashboard.renameFolderInState({
      path: newPath,
      newPath: path,
    });
    effects.notificationToast.error('There was a problem renaming you folder');
  }
};

export const deleteFolder: AsyncAction<{
  path: string;
}> = async ({ state: { dashboard }, effects }, { path }) => {
  if (!dashboard.allCollections) return;
  const oldCollections = dashboard.allCollections;
  dashboard.allCollections = dashboard.allCollections.filter(
    folder => folder.path !== path
  );
  try {
    await effects.gql.mutations.deleteFolder({
      path,
      teamId: dashboard.activeTeam,
    });
  } catch {
    dashboard.allCollections = oldCollections;
    effects.notificationToast.error('There was a problem deleting you folder');
  }
};

export const makeTemplate: AsyncAction<string[]> = async (
  { effects, state, actions },
  ids
) => {
  const oldSandboxes = state.dashboard.sandboxes;
  actions.dashboard.deleteSandboxFromState(ids);
  try {
    await effects.gql.mutations.makeSandboxesTemplate({
      sandboxIds: ids,
    });
  } catch (error) {
    state.dashboard.sandboxes = { ...oldSandboxes };
    effects.notificationToast.error('There was a problem making your template');
  }
};

export const permanentlyDeleteSandboxes: AsyncAction<string[]> = async (
  { effects, state },
  ids
) => {
  if (!state.dashboard.sandboxes.DELETED) return;
  const oldDeleted = state.dashboard.sandboxes.DELETED;
  state.dashboard.sandboxes.DELETED = oldDeleted.filter(
    sandbox => !ids.includes(sandbox.id)
  );
  try {
    await effects.gql.mutations.permanentlyDeleteSandboxes({ sandboxIds: ids });
  } catch (error) {
    state.dashboard.sandboxes.DELETED = [...oldDeleted];
    effects.notificationToast.error(
      'There was a problem deleting your sandbox'
    );
  }
};

export const recoverSandboxes: AsyncAction<string[]> = async (
  { effects, state },
  ids
) => {
  if (!state.dashboard.sandboxes.DELETED) return;
  const oldDeleted = state.dashboard.sandboxes.DELETED;
  state.dashboard.sandboxes.DELETED = oldDeleted.filter(
    sandbox => !ids.includes(sandbox.id)
  );
  try {
    await effects.gql.mutations.addSandboxToFolder({
      sandboxIds: ids,
      collectionPath: '/',
      // only way to pass, null is a value in the BE
      // @ts-ignore
      teamId: state.dashboard.activeTeam || undefined,
    });
  } catch (error) {
    state.dashboard.sandboxes.DELETED = [...oldDeleted];
    effects.notificationToast.error(
      'There was a problem recovering your sandbox'
    );
  }
};

export const downloadSandboxes: AsyncAction<string[]> = async (
  { effects },
  ids
) => {
  try {
    const sandboxIds = uniq(ids);
    const sandboxes = await Promise.all(
      sandboxIds.map(s => effects.api.getSandbox(s))
    );
    Promise.all(sandboxes.map(s => downloadZip(s, s.modules, s.directories)));
  } catch (error) {
    effects.notificationToast.error(
      'There was a problem reverting your template'
    );
  }
};

export const getSearchSandboxes: AsyncAction<string | null> = withLoadApp(
  async ({ state, effects }, search) => {
    const { dashboard } = state;
    try {
      const data = await effects.gql.queries.searchSandboxes({});
      if (!data || !data.me || !data.me.sandboxes) {
        return;
      }
      let lastSandboxes: any = null;
      let searchIndex: any = null;
      const sandboxes = data.me.sandboxes;

      if (lastSandboxes === null || lastSandboxes !== sandboxes) {
        searchIndex = new Fuse(sandboxes, {
          threshold: 0.1,
          distance: 1000,
          keys: [
            { name: 'title', weight: 0.4 },
            { name: 'description', weight: 0.2 },
            { name: 'alias', weight: 0.2 },
            { name: 'source.template', weight: 0.1 },
            { name: 'id', weight: 0.1 },
          ],
        });

        lastSandboxes = sandboxes;
      }

      const sandboxesToShow = state.dashboard
        .getFilteredSandboxes(searchIndex.search(search))
        .filter(x => !x.customTemplate)
        .filter(
          sandbox =>
            (sandbox.collection || { collection: {} }).teamId ===
            state.dashboard.activeTeam
        );

      dashboard.sandboxes[sandboxesTypes.SEARCH] = sandboxesToShow;
    } catch (error) {
      effects.notificationToast.error(
        'There was a problem getting your Sandboxes'
      );
    }
  }
);

export const getPage: AsyncAction<sandboxesTypes> = async (
  { actions: { dashboard } },
  page
) => {
  switch (page) {
    case sandboxesTypes.RECENT:
      dashboard.getRecentSandboxes();
      break;
    case sandboxesTypes.START_PAGE:
      dashboard.getStartPageSandboxes();
      break;
    case sandboxesTypes.DELETED:
      dashboard.getDeletedSandboxes();
      break;
    case sandboxesTypes.DRAFTS:
      dashboard.getDrafts();
      break;
    case sandboxesTypes.TEMPLATES:
      dashboard.getTemplateSandboxes();
      break;
    case sandboxesTypes.SEARCH:
      dashboard.getSearchSandboxes(
        new URLSearchParams(window.location.search).get('query')
      );
      break;

    default:
      break;
  }
};
