package com.example.demo;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

public class Main {
    record Point(int x, int y) {
        double length() {
            return Math.sqrt(x * x + y * y);
        }
    }

    public static void main(String[] args) {
        List<Point> points = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            points.add(new Point(i, i * 2));
        }
        String joined = points.stream()
                .filter(p -> p.length() > 5.0)
                .map(p -> "(" + p.x() + ", " + p.y() + ")")
                .collect(Collectors.joining(", "));
        System.out.println("Far points: " + joined);
        try {
            int[] data = new int[3];
            data[5] = 1;
        } catch (ArrayIndexOutOfBoundsException e) {
            System.err.println("Caught: " + e.getMessage());
        }
    }
}
