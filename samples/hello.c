#include <stdio.h>
#include <stdlib.h>

typedef struct {
    int id;
    const char *name;
} Item;

static int compare(const void *a, const void *b) {
    return ((const Item *)a)->id - ((const Item *)b)->id;
}

int main(void) {
    Item items[] = {{3, "three"}, {1, "one"}, {2, "two"}};
    size_t n = sizeof items / sizeof items[0];
    qsort(items, n, sizeof(Item), compare);
    for (size_t i = 0; i < n; i++) {
        printf("%d: %s\n", items[i].id, items[i].name);
    }
    return EXIT_SUCCESS;
}
