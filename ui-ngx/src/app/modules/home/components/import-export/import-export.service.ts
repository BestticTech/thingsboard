///
/// Copyright © 2016-2019 The Thingsboard Authors
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///

import { Inject, Injectable } from '@angular/core';
import { DashboardService } from '@core/http/dashboard.service';
import { TranslateService } from '@ngx-translate/core';
import { Store } from '@ngrx/store';
import { AppState } from '@core/core.state';
import { ActionNotificationShow } from '@core/notification/notification.actions';
import { Dashboard, DashboardLayoutId } from '@shared/models/dashboard.models';
import { deepClone, isDefined, isObject, isUndefined } from '@core/utils';
import { WINDOW } from '@core/services/window.service';
import { DOCUMENT } from '@angular/common';
import {
  AliasesInfo,
  AliasFilterType,
  EntityAlias,
  EntityAliases,
  EntityAliasFilter,
  EntityAliasInfo
} from '@shared/models/alias.models';
import { MatDialog } from '@angular/material/dialog';
import { ImportDialogComponent, ImportDialogData } from '@home/components/import-export/import-dialog.component';
import { forkJoin, Observable, of } from 'rxjs';
import { catchError, map, mergeMap } from 'rxjs/operators';
import { DashboardUtilsService } from '@core/services/dashboard-utils.service';
import { EntityService } from '@core/http/entity.service';
import { Widget, WidgetSize } from '@shared/models/widget.models';
import {
  EntityAliasesDialogComponent,
  EntityAliasesDialogData
} from '@home/components/alias/entity-aliases-dialog.component';
import { ItemBufferService, WidgetItem } from '@core/services/item-buffer.service';
import { ImportWidgetResult } from './import-export.models';
import { EntityType } from '@shared/models/entity-type.models';
import { UtilsService } from '@core/services/utils.service';

@Injectable()
export class ImportExportService {

  constructor(@Inject(WINDOW) private window: Window,
              @Inject(DOCUMENT) private document: Document,
              private store: Store<AppState>,
              private translate: TranslateService,
              private dashboardService: DashboardService,
              private dashboardUtils: DashboardUtilsService,
              private entityService: EntityService,
              private utils: UtilsService,
              private itembuffer: ItemBufferService,
              private dialog: MatDialog) {

  }

  public exportDashboard(dashboardId: string) {
    this.dashboardService.getDashboard(dashboardId).subscribe(
      (dashboard) => {
        let name = dashboard.title;
        name = name.toLowerCase().replace(/\W/g, '_');
        this.exportToPc(this.prepareDashboardExport(dashboard), name + '.json');
      },
      (e) => {
        let message = e;
        if (!message) {
          message = this.translate.instant('error.unknown-error');
        }
        this.store.dispatch(new ActionNotificationShow(
          {message: this.translate.instant('dashboard.export-failed-error', {error: message}),
            type: 'error'}));
      }
    );
  }

  public importDashboard(): Observable<Dashboard> {
    return this.openImportDialog('dashboard.import', 'dashboard.dashboard-file').pipe(
      mergeMap((dashboard: Dashboard) => {
        if (!this.validateImportedDashboard(dashboard)) {
          this.store.dispatch(new ActionNotificationShow(
            {message: this.translate.instant('dashboard.invalid-dashboard-file-error'),
              type: 'error'}));
          throw new Error('Invalid dashboard file');
        } else {
          dashboard = this.dashboardUtils.validateAndUpdateDashboard(dashboard);
          let aliasIds = null;
          const entityAliases = dashboard.configuration.entityAliases;
          if (entityAliases) {
            aliasIds = Object.keys(entityAliases);
          }
          if (aliasIds && aliasIds.length > 0) {
            return this.processEntityAliases(entityAliases, aliasIds).pipe(
              mergeMap((missingEntityAliases) => {
                if (Object.keys(missingEntityAliases).length > 0) {
                  return this.editMissingAliases(this.dashboardUtils.getWidgetsArray(dashboard),
                    false, 'dashboard.dashboard-import-missing-aliases-title',
                    missingEntityAliases).pipe(
                    mergeMap((updatedEntityAliases) => {
                      for (const aliasId of Object.keys(updatedEntityAliases)) {
                        entityAliases[aliasId] = updatedEntityAliases[aliasId];
                      }
                      return this.saveImportedDashboard(dashboard);
                    })
                  );
                } else {
                  return this.saveImportedDashboard(dashboard);
                }
              }
             ));
          } else {
            return this.saveImportedDashboard(dashboard);
          }
        }
      }),
      catchError((err) => {
        return of(null);
      })
    );
  }

  public exportWidget(dashboard: Dashboard, sourceState: string, sourceLayout: DashboardLayoutId, widget: Widget) {
    const widgetItem = this.itembuffer.prepareWidgetItem(dashboard, sourceState, sourceLayout, widget);
    let name = widgetItem.widget.config.title;
    name = name.toLowerCase().replace(/\W/g, '_');
    this.exportToPc(this.prepareExport(widgetItem), name + '.json');
  }

  public importWidget(dashboard: Dashboard, targetState: string,
                      targetLayoutFunction: () => Observable<DashboardLayoutId>,
                      onAliasesUpdateFunction: () => void): Observable<ImportWidgetResult> {
    return this.openImportDialog('dashboard.import-widget', 'dashboard.widget-file').pipe(
      mergeMap((widgetItem: WidgetItem) => {
        if (!this.validateImportedWidget(widgetItem)) {
          this.store.dispatch(new ActionNotificationShow(
            {message: this.translate.instant('dashboard.invalid-widget-file-error'),
              type: 'error'}));
          throw new Error('Invalid widget file');
        } else {
          let widget = widgetItem.widget;
          widget = this.dashboardUtils.validateAndUpdateWidget(widget);
          const aliasesInfo = this.prepareAliasesInfo(widgetItem.aliasesInfo);
          const originalColumns = widgetItem.originalColumns;
          const originalSize = widgetItem.originalSize;

          const datasourceAliases = aliasesInfo.datasourceAliases;
          const targetDeviceAliases = aliasesInfo.targetDeviceAliases;
          if (datasourceAliases || targetDeviceAliases) {
            const entityAliases: EntityAliases = {};
            const datasourceAliasesMap: {[aliasId: string]: number} = {};
            const targetDeviceAliasesMap: {[aliasId: string]: number} = {};
            let aliasId: string;
            let datasourceIndex: number;
            if (datasourceAliases) {
              for (const strIndex of Object.keys(datasourceAliases)) {
                datasourceIndex = Number(strIndex);
                aliasId = this.utils.guid();
                datasourceAliasesMap[aliasId] = datasourceIndex;
                entityAliases[aliasId] = {id: aliasId, ...datasourceAliases[datasourceIndex]};
              }
            }
            if (targetDeviceAliases) {
              for (const strIndex of Object.keys(targetDeviceAliases)) {
                datasourceIndex = Number(strIndex);
                aliasId = this.utils.guid();
                targetDeviceAliasesMap[aliasId] = datasourceIndex;
                entityAliases[aliasId] = {id: aliasId, ...targetDeviceAliases[datasourceIndex]};
              }
            }
            const aliasIds = Object.keys(entityAliases);
            if (aliasIds.length > 0) {
              return this.processEntityAliases(entityAliases, aliasIds).pipe(
                mergeMap((missingEntityAliases) => {
                    if (Object.keys(missingEntityAliases).length > 0) {
                      return this.editMissingAliases([widget],
                        false, 'dashboard.widget-import-missing-aliases-title',
                        missingEntityAliases).pipe(
                        mergeMap((updatedEntityAliases) => {
                          for (const id of Object.keys(updatedEntityAliases)) {
                            const entityAlias = updatedEntityAliases[id];
                            let index;
                            if (isDefined(datasourceAliasesMap[id])) {
                              index = datasourceAliasesMap[id];
                              datasourceAliases[index] = entityAlias;
                            } else if (isDefined(targetDeviceAliasesMap[id])) {
                              index = targetDeviceAliasesMap[id];
                              targetDeviceAliases[index] = entityAlias;
                            }
                          }
                          return this.addImportedWidget(dashboard, targetState, targetLayoutFunction, widget,
                            aliasesInfo, onAliasesUpdateFunction, originalColumns, originalSize);
                        }
                      ));
                    } else {
                      return this.addImportedWidget(dashboard, targetState, targetLayoutFunction, widget,
                        aliasesInfo, onAliasesUpdateFunction, originalColumns, originalSize);
                    }
                  }
                )
              );
            } else {
              return this.addImportedWidget(dashboard, targetState, targetLayoutFunction, widget,
                aliasesInfo, onAliasesUpdateFunction, originalColumns, originalSize);
            }
          } else {
            return this.addImportedWidget(dashboard, targetState, targetLayoutFunction, widget,
              aliasesInfo, onAliasesUpdateFunction, originalColumns, originalSize);
          }
        }
      }),
      catchError((err) => {
        return of(null);
      })
    );
  }

  private validateImportedDashboard(dashboard: Dashboard): boolean {
    if (isUndefined(dashboard.title) || isUndefined(dashboard.configuration)) {
      return false;
    }
    return true;
  }

  private validateImportedWidget(widgetItem: WidgetItem): boolean {
    if (isUndefined(widgetItem.widget)
      || isUndefined(widgetItem.aliasesInfo)
      || isUndefined(widgetItem.originalColumns)) {
      return false;
    }
    const widget = widgetItem.widget;
    if (isUndefined(widget.isSystemType) ||
      isUndefined(widget.bundleAlias) ||
      isUndefined(widget.typeAlias) ||
      isUndefined(widget.type)) {
      return false;
    }
    return true;
  }

  private saveImportedDashboard(dashboard: Dashboard): Observable<Dashboard> {
    return this.dashboardService.saveDashboard(dashboard);
  }

  private addImportedWidget(dashboard: Dashboard, targetState: string,
                            targetLayoutFunction: () => Observable<DashboardLayoutId>,
                            widget: Widget, aliasesInfo: AliasesInfo, onAliasesUpdateFunction: () => void,
                            originalColumns: number, originalSize: WidgetSize): Observable<ImportWidgetResult> {
    return targetLayoutFunction().pipe(
      mergeMap((targetLayout) => {
        return this.itembuffer.addWidgetToDashboard(dashboard, targetState, targetLayout,
          widget, aliasesInfo, onAliasesUpdateFunction, originalColumns, originalSize, -1, -1).pipe(
          map(() => ({widget, layoutId: targetLayout} as ImportWidgetResult))
        );
      }
    ));
  }

  private processEntityAliases(entityAliases: EntityAliases, aliasIds: string[]): Observable<EntityAliases> {
    const tasks: Observable<EntityAlias>[] = [];
    for (const aliasId of aliasIds) {
      const entityAlias = entityAliases[aliasId];
      tasks.push(
        this.entityService.checkEntityAlias(entityAlias).pipe(
          map((result) => {
            if (!result) {
              const missingEntityAlias = deepClone(entityAlias);
              missingEntityAlias.filter = null;
              return missingEntityAlias;
            }
            return null;
          }
          )
        )
      );
    }
    return forkJoin(tasks).pipe(
      map((missingAliasesArray) => {
          missingAliasesArray = missingAliasesArray.filter(alias => alias !== null);
          const missingEntityAliases: EntityAliases = {};
          for (const missingAlias of missingAliasesArray) {
            missingEntityAliases[missingAlias.id] = missingAlias;
          }
          return missingEntityAliases;
        }
      )
    );
  }

  private editMissingAliases(widgets: Array<Widget>, isSingleWidget: boolean,
                             customTitle: string, missingEntityAliases: EntityAliases): Observable<EntityAliases> {
    return this.dialog.open<EntityAliasesDialogComponent, EntityAliasesDialogData,
      EntityAliases>(EntityAliasesDialogComponent, {
      disableClose: true,
      panelClass: ['tb-dialog', 'tb-fullscreen-dialog'],
      data: {
        entityAliases: missingEntityAliases,
        widgets,
        customTitle,
        isSingleWidget,
        disableAdd: true
      }
    }).afterClosed().pipe(
      map((updatedEntityAliases) => {
        if (updatedEntityAliases) {
          return updatedEntityAliases;
        } else {
          throw new Error('Unable to resolve missing entity aliases!');
        }
      }
    ));
  }

  private prepareAliasesInfo(aliasesInfo: AliasesInfo): AliasesInfo {
    const datasourceAliases = aliasesInfo.datasourceAliases;
    const targetDeviceAliases = aliasesInfo.targetDeviceAliases;
    if (datasourceAliases || targetDeviceAliases) {
      if (datasourceAliases) {
        for (const strIndex of Object.keys(datasourceAliases)) {
          const datasourceIndex = Number(strIndex);
          datasourceAliases[datasourceIndex] = this.prepareEntityAlias(datasourceAliases[datasourceIndex]);
        }
      }
      if (targetDeviceAliases) {
        for (const strIndex of Object.keys(targetDeviceAliases)) {
          const datasourceIndex = Number(strIndex);
          targetDeviceAliases[datasourceIndex] = this.prepareEntityAlias(targetDeviceAliases[datasourceIndex]);
        }
      }
    }
    return aliasesInfo;
  }

  private prepareEntityAlias(aliasInfo: EntityAliasInfo): EntityAliasInfo {
    let alias: string;
    let filter: EntityAliasFilter;
    if (aliasInfo.deviceId) {
      alias = aliasInfo.aliasName;
      filter = {
        type: AliasFilterType.entityList,
        entityType: EntityType.DEVICE,
        entityList: [aliasInfo.deviceId],
        resolveMultiple: false
      };
    } else if (aliasInfo.deviceFilter) {
      alias = aliasInfo.aliasName;
      filter = {
        type: aliasInfo.deviceFilter.useFilter ? AliasFilterType.entityName : AliasFilterType.entityList,
        entityType: EntityType.DEVICE,
        resolveMultiple: false
      };
      if (filter.type === AliasFilterType.entityList) {
        filter.entityList = aliasInfo.deviceFilter.deviceList;
      } else {
        filter.entityNameFilter = aliasInfo.deviceFilter.deviceNameFilter;
      }
    } else if (aliasInfo.entityFilter) {
      alias = aliasInfo.aliasName;
      filter = {
        type: aliasInfo.entityFilter.useFilter ? AliasFilterType.entityName : AliasFilterType.entityList,
        entityType: aliasInfo.entityType,
        resolveMultiple: false
      };
      if (filter.type === AliasFilterType.entityList) {
        filter.entityList = aliasInfo.entityFilter.entityList;
      } else {
        filter.entityNameFilter = aliasInfo.entityFilter.entityNameFilter;
      }
    } else {
      alias = aliasInfo.alias;
      filter = aliasInfo.filter;
    }
    return {
      alias,
      filter
    };
  }

  private openImportDialog(importTitle: string, importFileLabel: string): Observable<any> {
    return this.dialog.open<ImportDialogComponent, ImportDialogData,
      any>(ImportDialogComponent, {
      disableClose: true,
      panelClass: ['tb-dialog', 'tb-fullscreen-dialog'],
      data: {
        importTitle,
        importFileLabel
      }
    }).afterClosed().pipe(
      map((importedData) => {
        if (importedData) {
          return importedData;
        } else {
          throw new Error('No file selected!');
        }
      }
    ));
  }

  private exportToPc(data: any, filename: string) {
    if (!data) {
      console.error('No data');
      return;
    }
    if (!filename) {
      filename = 'download.json';
    }
    if (isObject(data)) {
      data = JSON.stringify(data, null,  2);
    }
    const blob = new Blob([data], {type: 'text/json'});
    if (this.window.navigator && this.window.navigator.msSaveOrOpenBlob) {
      this.window.navigator.msSaveOrOpenBlob(blob, filename);
    } else {
      const e = this.document.createEvent('MouseEvents');
      const a = this.document.createElement('a');
      a.download = filename;
      a.href = this.window.URL.createObjectURL(blob);
      a.dataset.downloadurl = ['text/json', a.download, a.href].join(':');
      // @ts-ignore
      e.initEvent('click', true, false, this.window,
        0, 0, 0, 0, 0, false, false, false, false, 0, null);
      a.dispatchEvent(e);
    }
  }

  private prepareDashboardExport(dashboard: Dashboard): Dashboard {
    dashboard = this.prepareExport(dashboard);
    delete dashboard.assignedCustomers;
    return dashboard;
  }

  private prepareExport(data: any): any {
    const exportedData = deepClone(data);
    if (isDefined(exportedData.id)) {
      delete exportedData.id;
    }
    if (isDefined(exportedData.createdTime)) {
      delete exportedData.createdTime;
    }
    if (isDefined(exportedData.tenantId)) {
      delete exportedData.tenantId;
    }
    if (isDefined(exportedData.customerId)) {
      delete exportedData.customerId;
    }
    return exportedData;
  }

}