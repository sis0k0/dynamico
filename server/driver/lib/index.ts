import {
  IndexStorage,
  ComponentsStorage,
  Component,
  ComponentGetter,
  ComponentTree,
  ComponentTreeItem,
  Dependencies,
  Issues,
  Storage,
  Mismatches,
  Maybe,
  Host,
  File,
  Index
} from '@dynamico/common-types';
import compareVersions from 'compare-versions';
import semver from 'semver';
import MurmurHash3 from 'imurmurhash';

import {
  NoComponentError,
  NoComponentVersionError,
  ComponentExistsError,
  NoPackageError,
  UnknownHostIdError
} from './errors';
export class Driver {
  constructor(private storage: Storage) {}

  async registerHost(dependencies: Dependencies = {}): Promise<{ id: string; issues: Issues<Component> }> {
    let issues = {};

    const sortedDependencies = Object.entries(dependencies).sort(([nameA], [nameB]) => nameA.localeCompare(nameB));
    const id = MurmurHash3(JSON.stringify(sortedDependencies)).result();

    const index = await this.storage.getIndex();

    if (!index[id]) {
      issues = await this.upsertIndex({
        id,
        dependencies
      });
    }

    return {
      id,
      issues
    };
  }

  private async isCompatible(host: Host, comp: ComponentTreeItem): Promise<Maybe<{ mismatches: Mismatches }>> {
    const compDeps = await comp.getDependencies();
    const mismatches: Mismatches = {};

    for (let dep in compDeps) {
      if (!host.dependencies[dep]) {
        return;
      }

      if (!semver.intersects(host.dependencies[dep], compDeps[dep])) {
        return;
      }

      const { version } = semver.minVersion(host.dependencies[dep])!;

      if (!semver.satisfies(version, compDeps[dep])) {
        mismatches[dep] = {
          host: host.dependencies[dep],
          component: compDeps[dep]
        };
      }
    }

    return {
      mismatches
    };
  }

  private async upsertIndex(host: Host): Promise<Issues<Component>> {
    const tree = await this.storage.getComponentTree();
    let incompatibilityIssues: Issues<Component> = {};

    const components = await Object.entries(tree).reduce(async (sum, [name, versionTree]) => {
      const sortedVersions = Object.entries(versionTree).sort(([a], [b]) => compareVersions(b, a));

      for (const [version, getDependencies] of sortedVersions) {
        const isCompatible = await this.isCompatible(host, { name, version, getDependencies });
        if (isCompatible) {
          incompatibilityIssues[name] = {
            version,
            mismatches: isCompatible.mismatches
          };
          return {
            ...(await sum),
            [name]: version
          };
        }
      }
      return sum;
    }, Promise.resolve({}));

    await this.storage.upsertIndex({
      [host.id]: {
        dependencies: host.dependencies,
        components
      }
    });

    return incompatibilityIssues;
  }

  private async updateHosts(component: ComponentTreeItem): Promise<Issues<Host>> {
    const hostIssues = {};

    const index = await Object.entries(await this.storage.getIndex()).reduce(
      async (sum, [id, { dependencies, components }]) => {
        if (components[component.name] && compareVersions(components[component.name], component.version) >= 0) {
          return sum;
        }

        const isCompatible = await this.isCompatible({ id, dependencies }, component);

        if (isCompatible) {
          components[component.name] = component.version;
          hostIssues[id] = {
            mismatches: isCompatible.mismatches
          };
        }

        return {
          ...(await sum),
          [id]: {
            dependencies,
            components
          }
        };
      },
      Promise.resolve({})
    );

    await this.storage.upsertIndex(index);

    return hostIssues;
  }

  async getComponent({ hostId = '', name, version }: { hostId?: string } & Component): Promise<ComponentGetter> {
    if (!version) {
      const index = await this.storage.getIndex();

      if (!index[hostId]) {
        throw new UnknownHostIdError({ hostId });
      }

      if (!index[hostId].components[name]) {
        throw new NoComponentError({ name });
      }

      version = index[hostId].components[name];
    }

    const componentGetter = await this.storage.getComponent(name, version);

    if (!componentGetter) {
      throw new NoComponentError({ name, version });
    }

    return componentGetter;
  }

  async saveComponent(
    component: Required<Component> & { dependencies: Dependencies },
    files: File[]
  ): Promise<Issues<Host>> {
    if (!component.version) {
      throw new NoComponentVersionError({ component });
    }

    const componentTree = await this.storage.getComponentTree();

    if (componentTree[component.name]) {
      const componentGetter = componentTree[component.name][component.version];

      if (componentGetter) {
        throw new ComponentExistsError({ component });
      }
    }

    if (!files.filter(({ name }) => name === 'package.json').length) {
      throw new NoPackageError({
        component,
        files
      });
    }

    await this.storage.saveComponent(component, files);

    return this.updateHosts({
      ...component,
      getDependencies: async () => component.dependencies
    });
  }
}
